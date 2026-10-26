import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleAlert, CircleCheck, ClipboardList, CloudOff, FileText, LayoutDashboard, Moon,
  RefreshCw, Settings2, Smartphone, Sun, Workflow, X,
} from '../components/icons'
import CaseEditor from '../features/cases/CaseEditor'
import Overview from '../pages/Overview'
import Cases from '../pages/Cases'
import Plans from '../pages/Plans'
import Reports from '../pages/Reports'
import ReportPage from '../pages/ReportPage'
import { BrandMark } from '../components/ui'
import { scroller } from '../shared/scroll'
import { shortId, statusLabel } from '../shared/format'
import { parseRoute, routeHash, sameRoute, transition, type Route } from './router'
import type { LiveEvent, RunProgress, View } from './types'
import {
  api, type CaseRecord, type DriverKind, type PlanRecord, type ProviderConfig, type ProviderPreset, type RunRecord,
} from '../shared/api'

// Heavy, rarely-first pages are split out and warmed up on idle so navigation never waits on a chunk.
const loadDevices = () => import('../features/devices/Devices')
const loadSettings = () => import('../pages/Settings')
const Devices = lazy(loadDevices)
const Settings = lazy(loadSettings)

const navItems: { key: View; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'overview', label: '工作台', icon: LayoutDashboard },
  { key: 'cases', label: '用例管理', icon: ClipboardList },
  { key: 'plans', label: '测试计划', icon: Workflow },
  { key: 'reports', label: '运行报告', icon: FileText },
  { key: 'devices', label: 'Android 设备', icon: Smartphone },
  { key: 'settings', label: '系统设置', icon: Settings2 },
]

type Theme = 'light' | 'dark'
const initialTheme = (): Theme => {
  const saved = localStorage.getItem('autorush-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const routeRef = useRef(route)
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
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const notify = (text: string, error = false) => setNotice({ text, error })
  const pushEvent = (event: LiveEvent) => setEvents(current => [event, ...current].slice(0, 30))

  const go = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const from = routeRef.current
    if (sameRoute(from, next)) return
    history[options.replace ? 'replaceState' : 'pushState'](null, '', routeHash(next))
    routeRef.current = next
    transition(from, next, () => {
      setRoute(next)
      if (from.view !== next.view || next.view === 'reports') scroller()?.scrollTo({ top: 0 })
    })
  }, [])
  useEffect(() => {
    if (!location.hash) history.replaceState(null, '', routeHash(routeRef.current))
    const onPop = () => {
      const next = parseRoute(location.hash), from = routeRef.current
      routeRef.current = next
      transition(from, next, () => setRoute(next))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    const warm = () => { void loadDevices(); void loadSettings() }
    const idle = typeof requestIdleCallback === 'function'
    const id = idle ? requestIdleCallback(warm, { timeout: 3000 }) : window.setTimeout(warm, 1500)
    return () => { if (idle) cancelIdleCallback(id); else window.clearTimeout(id) }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('autorush-theme', theme)
  }, [theme])
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setTheme(next); return }
    document.documentElement.dataset.nav = 'theme'
    void document.startViewTransition(() => { document.documentElement.dataset.theme = next; setTheme(next) }).finished.finally(() => { delete document.documentElement.dataset.nav })
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      await api.health()
      const [nextCases, nextPlans, nextRuns, nextPresets, nextProviderConfigs] = await Promise.all([
        api.cases(true), api.plans(), api.runs(), api.providerPresets(), api.providerConfigs(),
      ])
      setCases(nextCases); setPlans(nextPlans); setRuns(nextRuns)
      setProviderPresets(nextPresets); setProviderConfigs(nextProviderConfigs); setConnected(true)
    } catch (error) { setConnected(false); notify(error instanceof Error ? error.message : '加载失败', true) }
    finally { setLoading(false); setLoaded(true) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    let disposed = false
    let reconnect: number | undefined
    let closeSocket: (() => void) | undefined
    const connect = () => {
      closeSocket = api.watchEvents(event => {
        if (event.type === 'run.started') {
          setProgress({ runId: event.payload.run_id, completed: 0, total: event.payload.case_count })
          setNotice({ text: `测试开始：${event.payload.case_count} 个用例`, error: false })
          pushEvent({ id: event.id, at: event.created_at, tone: 'info', text: `运行 #${shortId(event.payload.run_id)} 开始 · ${event.payload.case_count} 个用例` })
        } else if (event.type === 'case.completed') {
          const status = statusLabel[event.payload.status] ?? event.payload.status
          setProgress({ runId: event.payload.run_id, completed: event.payload.completed, total: event.payload.total })
          setNotice({ text: `执行进度 ${event.payload.completed}/${event.payload.total} · ${status}`, error: false })
          pushEvent({ id: event.id, at: event.created_at, tone: event.payload.status === 'passed' ? 'passed' : 'failed', text: `用例完成 ${event.payload.completed}/${event.payload.total} · ${status}` })
        } else if(event.type==='agent.run.failed') {
          setProgress(null)
          setNotice({text:'模型执行中断，报告未能保存；请恢复执行状态查看原因。',error:true})
        } else if (event.type === 'report.ready') {
          setProgress(null)
          setNotice({ text: `报告 ${shortId(event.payload.run_id)} 已生成`, error: false })
          pushEvent({ id: event.id, at: event.created_at, tone: event.payload.status === 'passed' ? 'passed' : 'failed', text: `报告 #${shortId(event.payload.run_id)} 已生成 · ${statusLabel[event.payload.status] ?? event.payload.status}` })
          void refresh()
        }
      }, () => {
        if (!disposed) reconnect = window.setTimeout(connect, 2000)
      })
    }
    connect()
    return () => { disposed = true; if (reconnect) window.clearTimeout(reconnect); closeSocket?.() }
  }, [refresh])
  useEffect(() => { if (!notice) return; const timeout = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(timeout) }, [notice])

  const navigate = (next: View) => go({ view: next })
  const authorizeLocal=async()=>{api.setOperatorToken((await api.operatorSession()).operator_token)}
  const action = async (fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    try { await fn(); notify(success); await refresh(); return true }
    catch (error) { notify(error instanceof Error ? error.message : '操作失败', true); return false }
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
    : creatingCase ? '新建' : editingCase ? '编辑' : null

  const caseEditor = (creatingCase || editingCase) && <CaseEditor
    key={editingCase ? `${editingCase.id}-${editingCase.version}` : `new-${newCasePlatform}`}
    initial={editingCase} initialPlatform={newCasePlatform} providers={providerConfigs}
    onCancel={() => go({ view: 'cases', id: editingCase?.id }, { replace: true })}
    onSave={async payload => {
      let saved: CaseRecord | undefined
      const ok = await action(async () => {
        if (editingCase) { await authorizeLocal(); saved = await api.updateCase(editingCase.id, editingCase.version, payload) }
        else saved = await api.createCase(payload)
      }, editingCase ? '用例已保存为草稿' : '用例草稿已创建')
      if (ok) go({ view: 'cases', id: saved?.id }, { replace: true })
    }} />

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><BrandMark /><div><strong>AutoRush</strong><span>AI Tester</span></div></div>
      <nav>{navItems.map(item => <a key={item.key} href={routeHash({ view: item.key })} aria-label={item.label} aria-current={view === item.key ? 'page' : undefined}
        className={view === item.key ? 'nav-item active' : 'nav-item'}
        onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; event.preventDefault(); navigate(item.key) }}>
        {view === item.key && <span className="nav-indicator" aria-hidden="true" />}
        <item.icon size={17} />
        <span className="nav-text">{item.label}</span>
        {Boolean(counts[item.key]) && <span className="nav-count" aria-hidden="true">{counts[item.key]}</span>}
      </a>)}</nav>
      <div className="sidebar-bottom">
        <div className={`backend-card ${connected ? 'online' : 'offline'}`}>
          <span className="backend-pulse" />
          <div><strong>{connected ? '本地后端在线' : '后端未连接'}</strong><span className="mono">127.0.0.1:8000</span></div>
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
          {progress && <div className="run-progress" title={`运行 #${shortId(progress.runId)}`}>
            <span className="run-progress-label"><span className="live-dot" />运行中 {progress.completed}/{progress.total}</span>
            <span className="run-progress-track"><span style={{ transform: `scaleX(${progress.total ? progress.completed / progress.total : 0})` }} /></span>
          </div>}
          <span className={`connection ${connected ? 'online' : 'offline'}`}>{connected ? <CircleCheck size={14} /> : <CloudOff size={14} />}{connected ? '已连接' : '未连接'}</span>
          <button className="icon-button" aria-label="切换主题" title={theme === 'dark' ? '浅色模式' : '深色模式'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button className="icon-button" aria-label="刷新数据" title="刷新数据" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spinning' : ''} /></button>
        </div>
      </header>
      <div className="main-scroll" id="main-scroll">
      <main key={view} className={view === 'cases' ? 'main-content fill' : 'main-content'}>
        <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
          {view === 'overview' && <Overview cases={activeCases} plans={plans} runs={runs} events={events} onNavigate={navigate} onNewCase={() => { setNewCasePlatform('web'); go({ view: 'cases', id: 'new' }) }} onOpenRun={id => go({ view: 'reports', id })} />}
          {view === 'cases' && <Cases cases={cases} selectedId={creatingCase ? null : route.id ?? null} editor={caseEditor || null}
            onSelect={id => go({ view: 'cases', id: id ?? undefined }, { replace: true })}
            onCreate={platform => { setNewCasePlatform(platform); go({ view: 'cases', id: 'new' }, { replace: true }) }}
            onEdit={item => go({ view: 'cases', id: item.id, edit: true }, { replace: true })}
            onArchive={async id=>{await action(async()=>{await authorizeLocal();return api.archiveCase(id)},'用例已删除，可在已删除列表恢复')}}
            onRestore={async id=>{await action(async()=>{await authorizeLocal();return api.restoreCase(id)},'用例已恢复')}}
            onApprove={async id => { await action(() => api.approveCase(id), '用例已批准') }} />}
          {view === 'plans' && <Plans plans={plans} cases={cases} runs={runs} onCreate={payload => action(() => api.createPlan(payload), '计划已创建')} onReady={async id => { await action(() => api.readyPlan(id), '计划已就绪') }} onRun={async id => { await action(() => api.runPlan(id), '运行完成，报告已保存') }} />}
          {view === 'reports' && (route.id
            ? <ReportPage key={route.id} id={route.id} runs={runs} plans={plans} cases={cases} loaded={loaded}
                onBack={() => go({ view: 'reports' })}
                onOpen={id => go({ view: 'reports', id }, { replace: true })}
                onDownload={async (id, format) => { try { await api.downloadReport(id, format) } catch (error) { notify(error instanceof Error ? error.message : '下载失败', true) } }} />
            : <Reports runs={runs} plans={plans} onOpen={id => go({ view: 'reports', id })} onDownload={async (id, format) => { try { await api.downloadReport(id, format) } catch (error) { notify(error instanceof Error ? error.message : '下载失败', true) } }} />)}
          {view === 'devices' && <Devices />}
          {view === 'settings' && <Settings presets={providerPresets} configs={providerConfigs} onCreate={payload => action(() => api.createProviderConfig(payload), '模型配置已保存')} onPreflight={async id => { try { const result = await api.preflightProvider(id); notify(result.secret_available ? '本地预检查通过，尚未联网' : result.messages.join(' '), !result.secret_available); return result } catch (error) { notify(error instanceof Error ? error.message : '预检查失败', true); return null } }} />}
        </Suspense>
      </main>
      </div>
    </div>
    {notice && <div role="status" className={`toast ${notice.error ? 'error' : ''}`}>
      {notice.error ? <CircleAlert size={17} /> : <CircleCheck size={17} />}
      <span>{notice.text}</span>
      <button onClick={() => setNotice(null)} aria-label="关闭提示"><X size={14} /></button>
    </div>}
  </div>
}
