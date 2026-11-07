import { useEffect,useRef,useState } from 'react'
import { FileText, Globe, Monitor, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Server, ShieldCheck, Smartphone, Workflow, X } from '../components/icons'
import { api, type AgentExecution,type ProviderConfig,type CaseRecord, type DesktopTarget, type PlanPayload, type PlanRecord, type RunRecord } from '../shared/api'
import AgentProgress from '../features/runs/AgentProgress'
import PlanDetails from '../features/plans/PlanDetails'
import PlanEditorDialog from '../features/plans/PlanEditorDialog'
import { buildPlanPayload } from '../features/plans/target-form'
import {apiTesting} from '../features/api-testing/client'
import type {CollectionRecord} from '../features/api-testing/types'
import { DriverChip, EmptyState, PageHeader, Pagination, ResultBar, StatusBadge, usePaged } from '../components/ui'
import { driversOf, relative, shortId } from '../shared/format'

// Keep plan management and execution monitoring in separate views with shared run state.
export default function Plans({ plans, cases, runs, section, onNavigate, onSave, onReady, onRun }: {
  plans: PlanRecord[]
  cases: CaseRecord[]
  runs: RunRecord[]
  section?: string
  onNavigate: (section?: 'executions') => void
  onSave: (plan: PlanRecord | null, payload: PlanPayload) => Promise<PlanRecord>
  onReady: (id: string) => Promise<void>
  onRun: (id: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [editingPlan, setEditingPlan] = useState<PlanRecord | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('测试环境')
  const [apiBase, setApiBase] = useState('')
  const [apiEnvironmentId,setApiEnvironmentId]=useState('')
  const [apiEnvironments,setApiEnvironments]=useState<CollectionRecord[]>([])
  const [webBase, setWebBase] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [androidPackage, setAndroidPackage] = useState('')
  const [captureScreenshots, setCaptureScreenshots] = useState(true)
  const [webHeadless,setWebHeadless]=useState(true)
  const [viewportWidth,setViewportWidth]=useState('1280')
  const [viewportHeight,setViewportHeight]=useState('800')
  const [windows,setWindows]=useState<DesktopTarget[]>([])
  const [windowId,setWindowId]=useState('')
  const [desktopDelay,setDesktopDelay]=useState('3')
  const [formError,setFormError]=useState('')
  const [listError,setListError]=useState('')
  const [fetchingWindows,setFetchingWindows]=useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [caseQuery, setCaseQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [models,setModels]=useState<ProviderConfig[]>([])
  const [providerId,setProviderId]=useState('')
  const [rounds,setRounds]=useState(8)
  const [caseRounds,setCaseRounds]=useState(40)
  const [modelTimeout,setModelTimeout]=useState(90)
  const [caseTimeout,setCaseTimeout]=useState(600)
  const [executions,setExecutions]=useState<AgentExecution[]>([])
  const [monitoring,setMonitoring]=useState(false)
  const [connectingAgent,setConnectingAgent]=useState(false)
  const [pollError,setPollError]=useState('')
  const cancelPending=useRef(new Set<string>())
  const runKeys=useRef(new Map<string,string>())
  const [cancelling,setCancelling]=useState('')
  const showingExecutions = section === 'executions'
  const pagedExecutions = usePaged(executions, 'plan-executions', 6)
  // Fetch saved provider configurations for the plan's model picker.
  const loadModels=async()=>{try{setModels(await api.providerConfigs())}catch(cause){setFormError(String(cause))}}
  // Authorize the operator and reconnect the agent run monitor.
  const connectAgent=async()=>{
    setConnectingAgent(true)
    try{api.setOperatorToken((await api.operatorSession()).operator_token);setExecutions(await api.agentRuns());pagedExecutions.setPage(1);setMonitoring(true);setPollError('')}
    catch(cause){setPollError(cause instanceof Error?cause.message:'执行状态读取失败')}
    finally{setConnectingAgent(false)}
  }
  useEffect(()=>{void loadModels()},[editing])
  const detailEnvironmentId = plans.find(plan => plan.id === detailId)?.api_environment_id
  useEffect(()=>{
    if(!editing && !detailEnvironmentId) return
    let disposed = false
    void apiTesting.environments().then(items=>{if(!disposed)setApiEnvironments(items)})
      .catch(cause=>{if(!disposed && editing)setFormError(String(cause))})
    return ()=>{disposed = true}
  },[editing,detailEnvironmentId])
  useEffect(()=>{
    if(!monitoring||connectingAgent||!executions.some(e=>['running','stopping'].includes(e.state)))return
    let disposed=false
    const timer=window.setTimeout(()=>{void api.agentRuns().then(rows=>{if(!disposed){setExecutions(rows);setPollError('')}}).catch(cause=>{if(!disposed){setPollError(cause instanceof Error?cause.message:'执行状态连接中断');setMonitoring(false)}})},1500)
    return()=>{disposed=true;window.clearTimeout(timer)}
  },[monitoring,connectingAgent,executions])
  useEffect(() => { if (showingExecutions) setEditing(false) }, [showingExecutions])
  // Request cancellation once per active execution and update its displayed state.
  const stop=async(id:string)=>{
    if(cancelPending.current.has(id))return
    cancelPending.current.add(id);setCancelling(id)
    try{const result=await api.cancelAgentRun(id);setExecutions(old=>old.map(e=>e.id===id?result:e))}
    catch(cause){cancelPending.current.delete(id);setPollError(cause instanceof Error?cause.message:'停止请求失败')}
    finally{setCancelling('')}
  }
  // Start a standard run or an agent run, retaining the agent retry key until accepted.
  const run=async(id:string)=>{
    const plan=plans.find(p=>p.id===id)
    if(!plan?.agent_options)return onRun(id)
    const key=runKeys.current.get(id)||crypto.randomUUID();runKeys.current.set(id,key)
    api.setOperatorToken((await api.operatorSession()).operator_token)
    const record=await api.startAgentRun(id,key)
    setExecutions(old=>[record,...old.filter(e=>e.id!==record.id)]);setMonitoring(true)
    runKeys.current.delete(id)
    pagedExecutions.setPage(1)
    onNavigate('executions')
  }
  const approved = cases.filter(item => item.status === 'approved'&&!item.archived_at)
  const casesById = new Map(cases.map(item => [item.id, item]))
  const hasAndroid = approved.some(item => selected.includes(item.id) && [...item.steps, ...item.postconditions].some(step => step.driver === 'android'))
  const selectedCases=approved.filter(item=>selected.includes(item.id))
  const hasUnavailableCases = selectedCases.length !== selected.length
  const pickable=approved.filter(item=>item.title.toLowerCase().includes(caseQuery.trim().toLowerCase()))
  const paged=usePaged(plans,'plans',10)
  const hasWeb=selectedCases.some(c=>[...c.steps,...c.postconditions].some(s=>s.driver==='web'))
  const hasDesktop=selectedCases.some(c=>[...c.steps,...c.postconditions].some(s=>s.driver==='desktop'))
  const hasUI=hasAndroid||hasWeb||hasDesktop
  const hasAgent=selectedCases.some(c=>c.execution_mode==='agent')
  const eligibleModels = models.filter(model => model.status === 'verified' && model.capabilities.includes('structured_output') &&
    ['openai_chat','openai_responses','anthropic_messages'].includes(model.protocol) && (!hasDesktop || model.vision_verified))

  // Reset the form from saved values, or restore creation defaults for a new plan.
  const openEditor = (plan: PlanRecord | null) => {
    setEditingPlan(plan)
    setName(plan?.name ?? '')
    setEnvironment(plan?.environment ?? '测试环境')
    setSelected(plan?.case_ids ?? [])
    setCaseQuery('')
    setApiBase(plan?.api_base_url ?? '')
    setApiEnvironmentId(plan?.api_environment_id ?? '')
    setWebBase(plan?.web_base_url ?? '')
    setDeviceId(plan?.android_device_id ?? '')
    setAndroidPackage(plan?.android_package ?? '')
    setCaptureScreenshots(plan?.capture_screenshots ?? true)
    setWebHeadless(plan?.web_headless ?? true)
    setViewportWidth(String(plan?.web_viewport?.width ?? 1280))
    setViewportHeight(String(plan?.web_viewport?.height ?? 800))
    setWindows(plan?.desktop_target ? [plan.desktop_target] : [])
    setWindowId(plan?.desktop_target ? String(plan.desktop_target.hwnd) : '')
    setDesktopDelay(String(plan?.desktop_start_delay_seconds ?? 3))
    setProviderId(plan?.agent_options?.provider_config_id ?? '')
    setRounds(plan?.agent_options?.max_rounds_per_step ?? 8)
    setCaseRounds(plan?.agent_options?.max_rounds_per_case ?? 40)
    setModelTimeout(plan?.agent_options?.model_timeout_seconds ?? 90)
    setCaseTimeout(plan?.agent_options?.case_timeout_seconds ?? 600)
    setFormError('')
    setEditing(true)
  }
  // Dismiss the editor without exposing its validation errors in the list.
  const closeEditor = () => {
    setEditing(false)
    setFormError('')
  }
  // Move one selected case without changing which cases are included.
  const moveCase = (index: number, offset: number) => {
    const next = [...selected]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    setSelected(next)
  }
  // Check desktop automation availability and list target windows.
  const connectLocal=async()=>{
    setFetchingWindows(true);setFormError('')
    try {
      const session=await api.operatorSession();api.setOperatorToken(session.operator_token)
      const capabilities=await api.automationCapabilities()
      if(!capabilities.desktop.available) throw new Error(capabilities.desktop.reason||'本地桌面执行不可用')
      const next = (await api.desktopWindows()).windows
      const current = windows.find(window => String(window.hwnd) === windowId)
      if (!next.some(window => window.hwnd === current?.hwnd && window.pid === current.pid)) setWindowId('')
      setWindows(next)
    } catch(cause){setFormError(cause instanceof Error?cause.message:'窗口加载失败')}
    finally {setFetchingWindows(false)}
  }
  // Build a validated plan from the selected cases and target settings, then save it.
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving || hasUnavailableCases) return
    setSaving(true); setFormError('')
    try {
      const payload = buildPlanPayload({name,environment,selected,apiBase,apiEnvironmentId,webBase,deviceId,androidPackage,
        captureScreenshots:hasDesktop||captureScreenshots,webHeadless,viewportWidth,viewportHeight,
        desktopTarget:windows.find(w=>String(w.hwnd)===windowId)||null,desktopDelay,
        agentOptions:{provider_config_id:providerId,max_rounds_per_step:rounds,max_rounds_per_case:caseRounds,
          model_timeout_seconds:modelTimeout,case_timeout_seconds:caseTimeout}},selectedCases)
      const updated = await onSave(editingPlan, payload)
      if (updated.id !== editingPlan?.id) paged.setPage(1)
      if (editingPlan) setDetailId(updated.id)
      closeEditor()
    }
    catch(cause){setFormError(cause instanceof Error?cause.message:'计划参数无效')}
    finally { setSaving(false) }
  }
  // Obtain authorization when a plan needs desktop or screenshot access before running its action.
  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusy(id)
    setListError('')
    try {
      const plan=plans.find(p=>p.id===id)
      if((plan?.desktop_target||plan?.capture_screenshots)&&!api.getOperatorToken()) {
        api.setOperatorToken((await api.operatorSession()).operator_token)
      }
      await fn(id)
    } catch(cause){setListError(cause instanceof Error?cause.message:'执行失败')}
    finally { setBusy(null) }
  }

  return <>
    <PageHeader
      title="测试计划"
      description={showingExecutions ? '查看自然语言计划的执行进度、停止运行或定位已生成的报告。'
        : '组合已批准用例，选择目标环境和自然语言执行模型，预检查通过后运行。'}
      actions={showingExecutions ?
        <button className="secondary-button" disabled={connectingAgent} onClick={()=>void connectAgent()} title="连接本机执行器并恢复模型执行状态"><RotateCcw size={14} className={connectingAgent?'spinning':''} />{connectingAgent?'正在恢复…':'恢复执行状态'}</button>
        : <button className="primary-button" onClick={() => openEditor(null)}><Plus size={15} /> 新建计划</button>}
    />
    <nav className="section-nav" aria-label="测试计划模块导航">
      <a href="#/plans" aria-current={!showingExecutions ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate() }}>计划列表</a>
      <a href="#/plans/executions" aria-current={showingExecutions ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate('executions') }}>执行状态</a>
    </nav>
    {showingExecutions ? <>
      {pollError&&<p role="alert" className="inline-alert error page-alert">{pollError}</p>}
      {executions.length ? <>
        <div className="card-list">{pagedExecutions.items.map(execution=><AgentProgress key={execution.id} execution={execution} onCancel={()=>void stop(execution.id)} busy={cancelling===execution.id}/>)}</div>
        <Pagination {...pagedExecutions} />
      </> : <section className="surface"><EmptyState icon={Workflow}
        title={connectingAgent ? '正在读取执行状态' : monitoring ? '暂无最近执行' : '恢复计划执行状态'}
        description={monitoring ? '启动自然语言计划后，执行进度会显示在这里。' : '从本机后端读取正在运行的任务及最近的模型执行记录。'} /></section>}
    </> : <>
    {listError&&<p role="alert" className="inline-alert error page-alert">{listError}</p>}
    <PlanEditorDialog open={editing} saving={saving} onClose={closeEditor}>
      <form className="plan-form" onSubmit={submit}>
      <div className="plan-dialog-header">
        <div>
          <h2 id="plan-dialog-title">{editingPlan ? '编辑测试计划' : '创建测试计划'}</h2>
          <p>{editingPlan?.status === 'ready' ? '保存为新修订草稿，保留原计划和历史报告。修订后需重新预检查。'
            : '配置目标环境并选择已批准用例。'}</p>
        </div>
        <button type="button" className="icon-button" aria-label="关闭计划编辑" disabled={saving} onClick={closeEditor}><X size={17} /></button>
      </div>
      {editing && formError && <p role="alert" className="inline-alert error plan-dialog-error">{formError}</p>}
      <div className="plan-dialog-content">
      <div className="form-section">
        <p className="form-section-label">基本信息</p>
        <div className="field-grid">
          <label className="field"><span>计划名称</span><input required data-plan-initial-focus value={name} onChange={event => setName(event.target.value)} placeholder="例如：发布前冒烟回归" /></label>
          <label className="field"><span>环境名称</span><input required value={environment} onChange={event => setEnvironment(event.target.value)} /></label>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-label">目标环境</p>
        <div className="field-grid">
          <label className="field"><span>API 基础地址</span><input className="mono-input" value={apiBase} onChange={event => setApiBase(event.target.value)} placeholder="https://api.example.test" /></label>
          <label className="field"><span>API 变量环境</span><select value={apiEnvironmentId} onChange={event=>setApiEnvironmentId(event.target.value)}><option value="">无环境</option>{apiEnvironmentId && !apiEnvironments.some(item => item.id === apiEnvironmentId) && <option value={apiEnvironmentId}>已保存环境 · #{shortId(apiEnvironmentId)}</option>}{apiEnvironments.map(item=><option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select><small>就绪时固定环境快照。完整 URL 的 API 节点可不填基础地址。</small></label>
          <label className="field"><span>Web 基础地址</span><input className="mono-input" value={webBase} onChange={event => setWebBase(event.target.value)} placeholder="https://app.example.test" /></label>
          <label className="field"><span>Android 设备 ID</span><input className="mono-input" value={deviceId} onChange={event => setDeviceId(event.target.value)} placeholder="从 Android 设备页复制 UUID" /></label>
          <label className="field"><span>Android App 包名</span><input className="mono-input" value={androidPackage} onChange={event => setAndroidPackage(event.target.value)} placeholder="com.example.app" /></label>
        </div>
        {hasWeb&&<div className="form-section"><p className="form-section-label">Playwright 浏览器</p>
          <div className="field-grid"><label className="field"><span>浏览器视口宽度</span><input type="number" min="320" max="3840" value={viewportWidth} onChange={e=>setViewportWidth(e.target.value)}/></label><label className="field"><span>浏览器视口高度</span><input type="number" min="240" max="2160" value={viewportHeight} onChange={e=>setViewportHeight(e.target.value)}/></label></div>
          <label className="check-line"><input type="checkbox" checked={webHeadless} onChange={e=>setWebHeadless(e.target.checked)}/>无头运行（关闭后显示独立 Chromium 窗口）</label>
        </div>}
        {hasDesktop&&<div className="form-section"><p className="form-section-label">PyAutoGUI 桌面窗口</p>
          <button type="button" className="secondary-button" disabled={fetchingWindows} onClick={()=>void connectLocal()}><RefreshCw size={14} className={fetchingWindows?'spinning':''}/>{fetchingWindows?'读取中…':'连接本地执行并刷新窗口'}</button>
          <div className="field-grid"><label className="field"><span>桌面目标窗口</span><select required value={windowId} onChange={e=>setWindowId(e.target.value)}><option value="">请选择目标窗口</option>{windows.map(w=><option key={w.hwnd} value={w.hwnd}>{w.title} · PID {w.pid} · {w.screen_width}×{w.screen_height}</option>)}</select></label><label className="field"><span>切回窗口准备时间（秒）</span><input type="number" min="0" max="10" value={desktopDelay} onChange={e=>setDesktopDelay(e.target.value)}/></label></div>
          <p className="quiet-note">点击运行后，请在准备时间内切回目标窗口。支持 Windows 主屏；窗口失焦或被遮挡时停止操作。鼠标移至主屏角落可紧急停止。</p>
        </div>}
        <label className="check-line"><input type="checkbox" checked={hasDesktop||hasAgent&&hasUI||hasUI&&captureScreenshots} disabled={!hasUI||hasDesktop||hasAgent} onChange={event => setCaptureScreenshots(event.target.checked)} />每步截图证据</label>
        <p className="quiet-note">Web / Android / Desktop 每步及后处理保存截图；桌面必须启用。Android 需手机截图许可，截图失败会在报告中明确标出。</p>
      </div>
      <div className="form-section">
        <div className="form-section-label case-picker-heading">
          <span className="form-section-title">选择已批准用例 <span>{selected.length} / {approved.length}</span></span>
          {approved.length > 8 && <label className="search-field"><Search size={15} /><input aria-label="搜索已批准用例" placeholder="筛选用例…" value={caseQuery} onChange={event => setCaseQuery(event.target.value)} /></label>}
        </div>
        {approved.length ? <div className="case-picker">
          {pickable.map(item => <label key={item.id} className={`case-choice ${selected.includes(item.id) ? 'checked' : ''}`}>
            <input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
            <span className="case-choice-title">{item.title}</span>
            <span className="chip-row">{driversOf(item.steps).map(driver => <DriverChip key={driver} driver={driver} />)}</span>
            <small>{item.steps.length} 步</small>
          </label>)}
        </div> : <p className="quiet-note">暂无已批准用例，请先到用例管理中批准。</p>}
        {selected.length > 0 && <>
          <p className="form-section-label">用例执行顺序</p>
          {hasUnavailableCases && <p role="alert" className="inline-alert error">请先移除不可用、未批准或已归档的用例。</p>}
          <ol className="plan-case-order">{selected.map((id, index) => {
            const item = casesById.get(id)
            return <li key={id}><div className="plan-case-order-row">
              <span>{item?.title ?? `用例不可用 · #${shortId(id)}`}</span>
              {item?.archived_at && <small>已归档</small>}
              <div className="plan-order-actions">
                <button type="button" className="text-button" disabled={index === 0} aria-label={`上移第 ${index + 1} 个用例`} onClick={() => moveCase(index, -1)}>上移</button>
                <button type="button" className="text-button" disabled={index === selected.length - 1} aria-label={`下移第 ${index + 1} 个用例`} onClick={() => moveCase(index, 1)}>下移</button>
                <button type="button" className="text-button" aria-label={`移除第 ${index + 1} 个用例`} onClick={() => setSelected(selected.filter(value => value !== id))}>移除</button>
              </div>
            </div></li>
          })}</ol>
        </>}
      </div>
      {hasAgent&&<div className="form-section">
          <div className="form-section-label"><span className="form-section-title">模型执行设置</span><button type="button" className="text-button" onClick={()=>void loadModels()}><RotateCcw size={13} />刷新模型配置</button></div>
          <label className="field wide"><span>执行模型</span><select required value={providerId} onChange={e=>setProviderId(e.target.value)}><option value="">请选择已验证模型</option>{providerId && providerId === editingPlan?.agent_options?.provider_config_id && !eligibleModels.some(model => model.id === providerId) && <option value={providerId}>已保存模型 · #{shortId(providerId)}</option>}{eligibleModels.map(m=><option key={m.id} value={m.id}>{m.name} · {m.vision_verified?'视觉已验证':'文本观察'}</option>)}</select></label>
          <div className="field-grid"><label className="field"><span>每步最大决策轮数</span><input type="number" min="1" max="20" value={rounds} onChange={e=>setRounds(Number(e.target.value))}/></label><label className="field"><span>每用例最大决策轮数</span><input type="number" min="1" max="200" value={caseRounds} onChange={e=>setCaseRounds(Number(e.target.value))}/></label><label className="field"><span>模型超时（秒）</span><input type="number" min="10" max="300" value={modelTimeout} onChange={e=>setModelTimeout(Number(e.target.value))}/></label><label className="field"><span>用例超时（秒）</span><input type="number" min="30" max="1800" value={caseTimeout} onChange={e=>setCaseTimeout(Number(e.target.value))}/></label></div>
        </div>}
      </div>
      <div className="form-actions">
        <button type="button" className="secondary-button" disabled={saving} onClick={closeEditor}>取消</button>
        <button type="submit" className="primary-button" disabled={saving || selected.length === 0 || hasUnavailableCases}>{saving ? '保存中…' : editingPlan?.status === 'ready' ? '保存为修订草稿' : editingPlan ? '保存修改' : '创建计划'}</button>
      </div>
      </form>
    </PlanEditorDialog>

    <div className="card-list">{plans.length ? paged.items.map(plan => {
      const planRuns = runs.filter(run => run.plan_id === plan.id)
      const lastRun = planRuns[0]
      const planCases = plan.case_ids.map(id => casesById.get(id)).filter((item): item is CaseRecord => Boolean(item))
      const expanded = detailId === plan.id
      return <section className="surface plan-card" key={plan.id}>
        <div className="plan-card-summary">
        <div className="plan-card-main">
          <div className="plan-title-line">
            <h3>{plan.name}</h3>
            <StatusBadge status={plan.status} />
          </div>
          <p className="plan-meta mono">#{shortId(plan.id)} · {plan.environment} · {plan.case_ids.length} 个用例 · v{plan.version}</p>
          <div className="plan-targets">
            {plan.api_base_url && <span><Server size={12} /> {plan.api_base_url}</span>}
            {plan.web_base_url && <span><Globe size={12} /> {plan.web_base_url}</span>}
            {plan.web_base_url && <span>{plan.web_headless===false?'Chromium 有头':'Chromium 无头'}</span>}
            {plan.desktop_target&&<span><Monitor size={12}/>{plan.desktop_target.title} · 运行后 {plan.desktop_start_delay_seconds} 秒切回目标</span>}
            {plan.android_device_id && <span><Smartphone size={12} /> {plan.android_package} · {shortId(plan.android_device_id)}</span>}
            {plan.capture_screenshots && <span>每步截图证据</span>}
          </div>
          {planCases.length > 0 && <p className="plan-cases">{planCases.slice(0, 3).map(item => item.title).join('、')}{planCases.length > 3 && ` 等 ${planCases.length} 个`}</p>}
        </div>
        <div className="plan-side">
          {lastRun ? <div className="plan-last-run">
            <span>上次运行 · {relative(lastRun.created_at)}</span>
            <ResultBar items={lastRun.cases} size="sm" />
          </div> : <div className="plan-last-run"><span>尚未运行</span></div>}
          <div className="plan-actions">
            <button className="secondary-button" aria-expanded={expanded} aria-controls={`plan-details-${plan.id}`} onClick={() => setDetailId(expanded ? null : plan.id)}><FileText size={14} /> {expanded ? '收起详情' : '查看详情'}</button>
            <button className="secondary-button" onClick={() => openEditor(plan)}><Pencil size={14} /> 编辑计划</button>
            {plan.status === 'draft'
            ? <button className="secondary-button" disabled={busy === plan.id} onClick={() => void act(plan.id, onReady)}><ShieldCheck size={15} /> 预检查并就绪</button>
            : <button className="primary-button" disabled={busy === plan.id||executions.some(e=>e.plan_id===plan.id&&['running','stopping'].includes(e.state))} onClick={() => void act(plan.id, run)}><Play size={14} /> {busy === plan.id ? '运行中…' : '运行计划'}</button>}
          </div>
        </div>
        </div>
        {expanded && <PlanDetails plan={plan} cases={casesById}
          modelName={models.find(model => model.id === plan.agent_options?.provider_config_id)?.name}
          environmentName={apiEnvironments.find(environment => environment.id === plan.api_environment_id)?.name} />}
      </section>
    }) : <section className="surface"><EmptyState icon={Workflow} title="还没有测试计划" description="选择已批准的用例并配置目标环境，创建第一个计划。" /></section>}</div>
    <Pagination {...paged} />
    </>}
  </>
}
