import { uiText } from '../shared/i18n.ts'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  Braces, CircleAlert, CircleCheck, ClipboardList, CloudOff, FileText, LayoutDashboard, Moon,
  RefreshCw, Settings2, Smartphone, Sun, Workflow, X,
} from '../components/icons'
import CaseEditor from '../features/cases/CaseEditor'
import CaseDebugPanel from '../features/case-debug/CaseDebugPanel'
import type {DebugSelection} from '../features/case-debug/client'
import Overview from '../pages/Overview'
import Cases from '../pages/Cases'
import Plans from '../pages/Plans'
import Reports from '../pages/Reports'
import ReportPage from '../pages/ReportPage'
import ApiWorkspace,{apiSections,type ApiNavigationGuard} from '../features/api-testing/ApiWorkspace'
import { BrandMark } from '../components/ui'
import { scroller } from '../shared/scroll'
import { shortId, statusLabel } from '../shared/format'
import { parseRoute, routeHash, sameRoute, transition, type Route } from './router'
import type { LiveEvent, RunProgress, View } from './types'
import {
  api, LOCAL_BACKEND_ADDRESS, type CaseRecord, type DriverKind, type PlanRecord, type ProviderConfig, type ProviderPreset, type RunRecord,
} from '../shared/api'

// Heavy, rarely-first pages are split out and warmed up on idle so navigation never waits on a chunk.
const loadDevices = () => import('../features/devices/Devices')
// Load the settings page chunk on demand or during idle warmup.
const loadSettings = () => import('../pages/Settings')
const Devices = lazy(loadDevices)
const Settings = lazy(loadSettings)

type NavItem = { key: View; label: string; icon: typeof LayoutDashboard }
// The main group follows the testing flow (write → plan → run → review); tools sit apart from it.
const navGroups: { label: string; items: NavItem[] }[] = [
  { label: uiText("测试流程"), items: [
    { key: 'overview', label: uiText("工作台"), icon: LayoutDashboard },
    { key: 'cases', label: uiText("用例管理"), icon: ClipboardList },
    { key: 'plans', label: uiText("测试计划"), icon: Workflow },
    { key: 'reports', label: uiText("运行报告"), icon: FileText },
  ] },
  { label: uiText("工具"), items: [
    { key: 'api-testing', label: uiText("API 测试"), icon: Braces },
    { key: 'devices', label: uiText("Android 设备"), icon: Smartphone },
    { key: 'settings', label: uiText("系统设置"), icon: Settings2 },
  ] },
]
const navItems = navGroups.flatMap(group => group.items)

type Theme = 'light' | 'dark'
// Prefer a saved theme and fall back to the system color scheme.
const initialTheme = (): Theme => {
  const saved = localStorage.getItem('autorush-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// Coordinate console navigation, shared records, live run events, and the active page.
export default function App() {
  const [debugSelection,setDebugSelection]=useState<DebugSelection|null>(null)
  const [debugOpen,setDebugOpen]=useState(false)
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const routeRef = useRef(route)
  const apiGuard=useRef<ApiNavigationGuard>(null)
  const navigationIndex=useRef<number>(typeof history.state?.autorushIndex==='number'?history.state.autorushIndex:0)
  const restoringHistory=useRef(false),bypassPopGuard=useRef(false),afterHistoryRestore=useRef<(()=>void)|null>(null)
  // Let the API workspace intercept navigation away from unsaved requests.
  const registerApiGuard=useCallback((guard:ApiNavigationGuard)=>{apiGuard.current=guard},[])
  const [cases, setCases] = useState<CaseRecord[]>([])
  const [plans, setPlans] = useState<PlanRecord[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>([])
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [newCasePlatform,setNewCasePlatform]=useState<DriverKind>('web')
  const activeCases=cases.filter(item=>!item.archived_at)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [notice, setNotice] = useState<{ text: string; error: boolean; leaving?: boolean } | null>(null)
  // Replace the current toast with a new success or error message.
  const notify = (text: string, error = false) => setNotice({ text, error })
  // Plays the exit animation first; the toast unmounts on its `animationend`.
  const dismissNotice = useCallback(() => setNotice(current => current && (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? null : { ...current, leaving: true })), [])
  // Keep the 30 newest events at the top of the activity feed.
  const pushEvent = (event: LiveEvent) => setEvents(current => [event, ...current].slice(0, 30))

  // Check for unsaved requests before updating history and animating the route.
  const go = useCallback((next: Route, options: { replace?: boolean;bypassApiGuard?:boolean } = {}) => {
    const from = routeRef.current
    if (sameRoute(from, next)) return
    if(from.view==='api-testing'&&next.view!=='api-testing'&&apiGuard.current&&!options.bypassApiGuard){apiGuard.current(()=>go(next,{...options,bypassApiGuard:true}));return}
    if(!options.replace)navigationIndex.current+=1
    history[options.replace ? 'replaceState' : 'pushState']({autorushIndex:navigationIndex.current}, '', routeHash(next))
    routeRef.current = next
    transition(from, next, () => {
      setRoute(next)
      if (from.view !== next.view || next.view === 'reports') scroller()?.scrollTo({ top: 0 })
    })
  }, [])
  useEffect(() => {
    if (!location.hash) history.replaceState({autorushIndex:navigationIndex.current}, '', routeHash(routeRef.current))
    else if(typeof history.state?.autorushIndex!=='number')history.replaceState({autorushIndex:navigationIndex.current},'',location.href)
    // Restore history while unsaved API edits are resolved, then replay the approved move.
    const onPop = (event:PopStateEvent) => {
      const targetIndex=typeof event.state?.autorushIndex==='number'?event.state.autorushIndex:navigationIndex.current-1
      if(restoringHistory.current){restoringHistory.current=false;navigationIndex.current=targetIndex;const action=afterHistoryRestore.current;afterHistoryRestore.current=null;action?.();return}
      const next = parseRoute(location.hash), from = routeRef.current
      const delta=targetIndex-navigationIndex.current
      if(from.view==='api-testing'&&next.view!=='api-testing'&&apiGuard.current&&!bypassPopGuard.current&&delta!==0){
        restoringHistory.current=true;history.go(-delta)
        apiGuard.current(()=>{/* Replay the approved history move once. */ const proceed=()=>{bypassPopGuard.current=true;history.go(delta)};if(restoringHistory.current)afterHistoryRestore.current=proceed;else proceed()})
        return
      }
      bypassPopGuard.current=false;navigationIndex.current=targetIndex
      routeRef.current = next
      transition(from, next, () => setRoute(next))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    // Fetch the lazy page chunks while the browser is idle.
    const warm = () => { void loadDevices(); void loadSettings() }
    const idle = typeof requestIdleCallback === 'function'
    const id = idle ? requestIdleCallback(warm, { timeout: 3000 }) : window.setTimeout(warm, 1500)
    return () => { if (idle) cancelIdleCallback(id); else window.clearTimeout(id) }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('autorush-theme', theme)
  }, [theme])
  // Switch color schemes with an optional view transition.
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setTheme(next); return }
    document.documentElement.dataset.nav = 'theme'
    void document.startViewTransition(() => { document.documentElement.dataset.theme = next; setTheme(next) }).finished.finally(() => { delete document.documentElement.dataset.nav })
  }

  // Check backend availability and refresh the records shared across console pages.
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      await api.health()
      const [nextCases, nextPlans, nextRuns, nextPresets, nextProviderConfigs] = await Promise.all([
        api.cases(true), api.plans(), api.runs(), api.providerPresets(), api.providerConfigs(),
      ])
      setCases(nextCases); setPlans(nextPlans); setRuns(nextRuns)
      setProviderPresets(nextPresets); setProviderConfigs(nextProviderConfigs); setConnected(true)
    } catch (error) { setConnected(false); notify(error instanceof Error ? error.message : uiText("加载失败"), true) }
    finally { setLoading(false); setLoaded(true) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    let disposed = false
    let reconnect: number | undefined
    let closeSocket: (() => void) | undefined
    // Update the console from live run events and reconnect when the stream closes.
    const connect = () => {
      closeSocket = api.watchEvents(event => {
        if (event.type === 'run.started') {
          setProgress({ runId: event.payload.run_id, completed: 0, total: event.payload.case_count })
          setNotice({ text: uiText("测试开始：{0} 个用例", event.payload.case_count), error: false })
          pushEvent({ id: event.id, at: event.created_at, tone: 'info', text: uiText("运行 #{0} 开始 · {1} 个用例", shortId(event.payload.run_id), event.payload.case_count) })
        } else if (event.type === 'case.completed') {
          const status = statusLabel[event.payload.status] ?? event.payload.status
          setProgress({ runId: event.payload.run_id, completed: event.payload.completed, total: event.payload.total })
          setNotice({ text: uiText("执行进度 {0}/{1} · {2}", event.payload.completed, event.payload.total, status), error: false })
          pushEvent({ id: event.id, at: event.created_at, tone: event.payload.status === 'passed' ? 'passed' : 'failed', text: uiText("用例完成 {0}/{1} · {2}", event.payload.completed, event.payload.total, status) })
        } else if(event.type==='agent.run.failed') {
          setProgress(null)
          setNotice({text:uiText("模型执行中断，报告未能保存；请恢复执行状态查看原因。"),error:true})
        } else if (event.type === 'report.ready') {
          setProgress(null)
          setNotice({ text: uiText("报告 {0} 已生成", shortId(event.payload.run_id)), error: false })
          pushEvent({ id: event.id, at: event.created_at, tone: event.payload.status === 'passed' ? 'passed' : 'failed', text: uiText("报告 #{0} 已生成 · {1}", shortId(event.payload.run_id), statusLabel[event.payload.status] ?? event.payload.status) })
          void refresh()
        }
      }, () => {
        if (!disposed) reconnect = window.setTimeout(connect, 2000)
      })
    }
    connect()
    return () => { disposed = true; if (reconnect) window.clearTimeout(reconnect); closeSocket?.() }
  }, [refresh])
  useEffect(() => { if (!notice || notice.leaving) return; const timeout = window.setTimeout(dismissNotice, 5000); return () => window.clearTimeout(timeout) }, [notice, dismissNotice])

  // Open a top-level page without carrying over detail or edit state.
  const navigate = (next: View) => go({ view: next })
  // Obtain and store a local operator token for privileged actions.
  const authorizeLocal=async()=>{api.setOperatorToken((await api.operatorSession()).operator_token)}
  // Run a mutation, report its outcome, and refresh the shared records on success.
  const action = async (fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    try { await fn(); notify(success); await refresh(); return true }
    catch (error) { notify(error instanceof Error ? error.message : uiText("操作失败"), true); return false }
  }
  const counts: Partial<Record<View, number>> = {
    cases: activeCases.filter(item => item.status === 'draft').length,
    plans: plans.filter(item => item.status === 'draft').length,
  }
  const view = route.view
  const page = navItems.find(item => item.key === view)?.label
  const editingCase = view === 'cases' && route.edit ? cases.find(item => item.id === route.id) : undefined
  const creatingCase = view === 'cases' && route.id === 'new'
  const crumb = view === 'reports' && route.id ? `#${shortId(route.id)}`
    : view === 'api-testing' ? apiSections.find(([key]) => key === (route.id ?? 'workbench'))?.[1] ?? null
    : view === 'plans' && route.id === 'executions' ? uiText("执行状态")
    : creatingCase ? uiText("新建") : editingCase ? uiText("编辑") : null

  const caseEditor = (creatingCase || editingCase) && <CaseEditor
    key={editingCase ? `${editingCase.id}-${editingCase.version}` : `new-${newCasePlatform}`}
    initial={editingCase} initialPlatform={newCasePlatform} providers={providerConfigs}
    onDebug={(read,sessionId)=>{setDebugSelection({read,sessionId,source:editingCase,saved:false});setDebugOpen(true)}}
    onCancel={() => go({ view: 'cases', id: editingCase?.id }, { replace: true })}
    onSave={async payload => {
      let saved: CaseRecord | undefined
      const ok = await action(async () => {
        if (editingCase) { await authorizeLocal(); saved = await api.updateCase(editingCase.id, editingCase.version, payload) }
        else saved = await api.createCase(payload)
      }, editingCase ? uiText("用例已保存为草稿") : uiText("用例草稿已创建"))
      if (ok) go({ view: 'cases', id: saved?.id }, { replace: true })
    }} />

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><BrandMark /><div><strong>AutoRush</strong><span>AI Tester</span></div></div>
      <nav>{navGroups.map(group => <div key={group.label} className="nav-group" role="group" aria-label={group.label}>
        <span className="nav-group-label" aria-hidden="true">{group.label}</span>
        {group.items.map(item => <a key={item.key} href={routeHash({ view: item.key })} aria-label={item.label} aria-current={view === item.key ? 'page' : undefined}
          className={view === item.key ? 'nav-item active' : 'nav-item'} title={item.label}
          onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; event.preventDefault(); navigate(item.key) }}>
          {view === item.key && <span className="nav-indicator" aria-hidden="true" />}
          <item.icon size={17} />
          <span className="nav-text">{item.label}</span>
          {Boolean(counts[item.key]) && <span className="nav-count" aria-hidden="true">{counts[item.key]}</span>}
        </a>)}
      </div>)}</nav>
      <div className="sidebar-bottom">
        <div className={`backend-card ${connected ? 'online' : 'offline'}`}>
          <span className="backend-pulse" />
          <div><strong>{connected ? uiText("本地后端在线") : uiText("后端未连接")}</strong><span className="mono">{LOCAL_BACKEND_ADDRESS}</span></div>
        </div>
        <div className="sidebar-version mono">v0.1 · local dev</div>
      </div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumbs">
          AutoRush<span>/</span>
          {crumb ? <a href={routeHash({ view })} onClick={event => { event.preventDefault(); go({ view }) }}>{page}</a> : <strong>{page}</strong>}
          {crumb && <><span>/</span><strong className={view === 'reports' ? 'mono' : undefined}>{crumb}</strong></>}
        </div>
        <div className="topbar-actions">
          {progress && <div className="run-progress" title={uiText("运行 #{0}", shortId(progress.runId))}>
            <span className="run-progress-label"><span className="live-dot" />{uiText("运行中 ")}{progress.completed}/{progress.total}</span>
            <span className="run-progress-track"><span style={{ transform: `scaleX(${progress.total ? progress.completed / progress.total : 0})` }} /></span>
          </div>}
          <span className={`connection ${connected ? 'online' : 'offline'}`}>{connected ? <CircleCheck size={14} /> : <CloudOff size={14} />}{connected ? uiText("已连接") : uiText("未连接")}</span>
          <button className="icon-button" aria-label={uiText("切换主题")} title={theme === 'dark' ? uiText("浅色模式") : uiText("深色模式")} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button className="icon-button" aria-label={uiText("刷新数据")} title={uiText("刷新数据")} onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spinning' : ''} /></button>
        </div>
      </header>
      <div className="main-scroll" id="main-scroll">
      <main key={view} className={view === 'cases' ? 'main-content fill' : view === 'api-testing' ? 'main-content api-main-content' : 'main-content'}>
        <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
          {view === 'overview' && <Overview cases={activeCases} plans={plans} runs={runs} events={events} onNavigate={navigate} onNewCase={() => { setNewCasePlatform('web'); go({ view: 'cases', id: 'new' }) }} onOpenRun={id => go({ view: 'reports', id })} />}
          {view === 'cases' && <Cases cases={cases} selectedId={creatingCase ? null : route.id ?? null} editor={caseEditor || null}
            onImported={refresh}
            onDebug={item=>{setDebugSelection({/* Supply the saved case as the debug input. */ read:()=>item,source:item,saved:true,sessionId:crypto.randomUUID()});setDebugOpen(true)}}
            onDebugHistory={()=>{setDebugSelection(null);setDebugOpen(true)}}
            onSelect={id => go({ view: 'cases', id: id ?? undefined }, { replace: true })}
            onCreate={platform => { setNewCasePlatform(platform); go({ view: 'cases', id: 'new' }, { replace: true }) }}
            onEdit={item => go({ view: 'cases', id: item.id, edit: true }, { replace: true })}
            onArchive={async id=>{await action(async()=>{await authorizeLocal();return api.archiveCase(id)},uiText("用例已删除，可在已删除列表恢复"))}}
            onRestore={async id=>{await action(async()=>{await authorizeLocal();return api.restoreCase(id)},uiText("用例已恢复"))}}
            onApprove={async id => { await action(() => api.approveCase(id), uiText("用例已批准")) }} />}
          {view === 'plans' && <Plans plans={plans} cases={cases} runs={runs} section={route.id}
            onNavigate={id => { if (routeRef.current.view === 'plans') go({view:'plans', id}) }}
            onSave={async (plan, payload) => {
              if (plan) await authorizeLocal()
              const saved = plan ? await api.updatePlan(plan.id, plan.version, payload) : await api.createPlan(payload)
              await refresh()
              notify(!plan ? uiText("计划已创建") : saved.id !== plan.id ? uiText("已创建计划修订草稿") : uiText("计划已保存"))
              return saved
            }}
            onReady={async id => { await action(async()=>{await authorizeLocal();return api.readyPlan(id)}, uiText("计划已就绪")) }}
            onRun={async id => { await action(async()=>{await authorizeLocal();return api.runPlan(id)}, uiText("运行完成，报告已保存")) }} />}
          {view === 'reports' && (route.id
            ? <ReportPage key={route.id} id={route.id} runs={runs} plans={plans} cases={cases} loaded={loaded}
                onBack={() => go({ view: 'reports' })}
                onOpen={id => go({ view: 'reports', id }, { replace: true })}
                onDownload={async (id, format) => { try { await api.downloadReport(id, format) } catch (error) { notify(error instanceof Error ? error.message : uiText("下载失败"), true) } }} />
            : <Reports runs={runs} plans={plans} onOpen={id => go({ view: 'reports', id })} onDownload={async (id, format) => { try { await api.downloadReport(id, format) } catch (error) { notify(error instanceof Error ? error.message : uiText("下载失败"), true) } }} />)}
          {view === 'devices' && <Devices />}
          {view === 'api-testing' && <ApiWorkspace section={route.id} onNavigate={id=>go({view:'api-testing',id})} onGuardChange={registerApiGuard} onCaseCreated={async id=>{await refresh();go({view:'cases',id},{bypassApiGuard:true})}}/>}
          {view === 'settings' && <Settings presets={providerPresets} configs={providerConfigs} onCreate={payload => action(() => api.createProviderConfig(payload), uiText("模型配置已保存"))} onPreflight={async id => { try { const result = await api.preflightProvider(id); notify(result.secret_available ? uiText("本地预检查通过，尚未联网") : result.messages.join(' '), !result.secret_available); return result } catch (error) { notify(error instanceof Error ? error.message : uiText("预检查失败"), true); return null } }} />}
        </Suspense>
      </main>
      </div>
    </div>
    <CaseDebugPanel open={debugOpen} selection={debugSelection} plans={plans} onClose={()=>setDebugOpen(false)}/>
    {notice && <div role="status" className={`toast${notice.error ? ' error' : ''}${notice.leaving ? ' leaving' : ''}`}
      onAnimationEnd={event => { if (event.animationName === 'toast-out') setNotice(null) }}>
      {notice.error ? <CircleAlert size={17} /> : <CircleCheck size={17} />}
      <span>{notice.text}</span>
      <button onClick={dismissNotice} aria-label={uiText("关闭提示")}><X size={14} /></button>
    </div>}
  </div>
}
