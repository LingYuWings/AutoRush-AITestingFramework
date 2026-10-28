import { useEffect,useRef,useState } from 'react'
import { Globe, Monitor, Play, Plus, RotateCcw, Search, Server, ShieldCheck, Smartphone, Workflow } from '../components/icons'
import { api, type AgentExecution,type ProviderConfig,type CaseRecord, type DesktopTarget, type PlanPayload, type PlanRecord, type RunRecord } from '../shared/api'
import AgentProgress from '../features/runs/AgentProgress'
import { buildPlanPayload } from '../features/plans/target-form'
import {apiTesting} from '../features/api-testing/client'
import type {CollectionRecord} from '../features/api-testing/types'
import { DriverChip, EmptyState, PageHeader, Pagination, ResultBar, StatusBadge, usePaged } from '../components/ui'
import { driversOf, relative, shortId } from '../shared/format'

export default function Plans({ plans, cases, runs, onCreate, onReady, onRun }: {
  plans: PlanRecord[]
  cases: CaseRecord[]
  runs: RunRecord[]
  onCreate: (payload: PlanPayload) => Promise<boolean>
  onReady: (id: string) => Promise<void>
  onRun: (id: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
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
  const loadModels=async()=>{try{setModels(await api.providerConfigs())}catch(cause){setFormError(String(cause))}}
  const connectAgent=async()=>{
    setConnectingAgent(true)
    try{api.setOperatorToken((await api.operatorSession()).operator_token);setExecutions(await api.agentRuns());setMonitoring(true);setPollError('')}
    catch(cause){setPollError(cause instanceof Error?cause.message:'执行状态读取失败')}
    finally{setConnectingAgent(false)}
  }
  useEffect(()=>{void loadModels()},[editing])
  useEffect(()=>{if(editing)void apiTesting.environments().then(setApiEnvironments).catch(cause=>setFormError(String(cause)))},[editing])
  useEffect(()=>{
    if(!monitoring||!executions.some(e=>['running','stopping'].includes(e.state)))return
    let disposed=false
    const timer=window.setTimeout(()=>{void api.agentRuns().then(rows=>{if(!disposed){setExecutions(rows);setPollError('')}}).catch(cause=>{if(!disposed){setPollError(cause instanceof Error?cause.message:'执行状态连接中断');setMonitoring(false)}})},1500)
    return()=>{disposed=true;window.clearTimeout(timer)}
  },[monitoring,executions])
  const stop=async(id:string)=>{
    if(cancelPending.current.has(id))return
    cancelPending.current.add(id);setCancelling(id)
    try{const result=await api.cancelAgentRun(id);setExecutions(old=>old.map(e=>e.id===id?result:e))}
    catch(cause){cancelPending.current.delete(id);setPollError(cause instanceof Error?cause.message:'停止请求失败')}
    finally{setCancelling('')}
  }
  const run=async(id:string)=>{
    const plan=plans.find(p=>p.id===id)
    if(!plan?.agent_options)return onRun(id)
    const key=runKeys.current.get(id)||crypto.randomUUID();runKeys.current.set(id,key)
    api.setOperatorToken((await api.operatorSession()).operator_token)
    const record=await api.startAgentRun(id,key)
    setExecutions(old=>[record,...old.filter(e=>e.id!==record.id)]);setMonitoring(true)
    runKeys.current.delete(id)
  }
  const approved = cases.filter(item => item.status === 'approved'&&!item.archived_at)
  const hasAndroid = approved.some(item => selected.includes(item.id) && [...item.steps, ...item.postconditions].some(step => step.driver === 'android'))
  const selectedCases=approved.filter(item=>selected.includes(item.id))
  const pickable=approved.filter(item=>item.title.toLowerCase().includes(caseQuery.trim().toLowerCase()))
  const paged=usePaged(plans,'plans',10)
  const hasWeb=selectedCases.some(c=>[...c.steps,...c.postconditions].some(s=>s.driver==='web'))
  const hasDesktop=selectedCases.some(c=>[...c.steps,...c.postconditions].some(s=>s.driver==='desktop'))
  const hasUI=hasAndroid||hasWeb||hasDesktop
  const hasAgent=selectedCases.some(c=>c.execution_mode==='agent')
  const connectLocal=async()=>{
    setFetchingWindows(true);setFormError('');setWindowId('')
    try {
      const session=await api.operatorSession();api.setOperatorToken(session.operator_token)
      const capabilities=await api.automationCapabilities()
      if(!capabilities.desktop.available) throw new Error(capabilities.desktop.reason||'本地桌面执行不可用')
      setWindows((await api.desktopWindows()).windows)
    } catch(cause){setWindows([]);setFormError(cause instanceof Error?cause.message:'窗口加载失败')}
    finally {setFetchingWindows(false)}
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true)
    try { if (await onCreate(buildPlanPayload({name,environment,selected,apiBase,apiEnvironmentId,webBase,deviceId,androidPackage,captureScreenshots:hasDesktop||captureScreenshots,
      webHeadless,viewportWidth,viewportHeight,desktopTarget:windows.find(w=>String(w.hwnd)===windowId)||null,desktopDelay,
      agentOptions:{provider_config_id:providerId,max_rounds_per_step:rounds,max_rounds_per_case:caseRounds,model_timeout_seconds:modelTimeout,case_timeout_seconds:caseTimeout}},selectedCases))) { setEditing(false); setName(''); setSelected([]); setCaptureScreenshots(true);setFormError('') } }
    catch(cause){setFormError(cause instanceof Error?cause.message:'计划参数无效')}
    finally { setSaving(false) }
  }
  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusy(id)
    try {
      const plan=plans.find(p=>p.id===id)
      if((plan?.desktop_target||plan?.capture_screenshots)&&!api.getOperatorToken()) {
        api.setOperatorToken((await api.operatorSession()).operator_token)
      }
      await fn(id)
    } catch(cause){setFormError(cause instanceof Error?cause.message:'执行失败')}
    finally { setBusy(null) }
  }

  return <>
    <PageHeader
      title="测试计划"
      description="组合已批准用例，选择目标环境和自然语言执行模型，预检查通过后运行。"
      actions={<>
        <button className="secondary-button" disabled={connectingAgent} onClick={()=>void connectAgent()} title="连接本机执行器并恢复模型执行状态"><RotateCcw size={14} className={connectingAgent?'spinning':''} />{connectingAgent?'正在恢复…':'恢复执行状态'}</button>
        <button className="primary-button" onClick={() => setEditing(!editing)}><Plus size={15} /> 新建计划</button>
      </>}
    />

    {formError&&<p role="alert" className="inline-alert error page-alert">{formError}</p>}
    {pollError&&<p role="alert" className="inline-alert error page-alert">{pollError}</p>}
    {executions.slice(0,5).map(execution=><AgentProgress key={execution.id} execution={execution} onCancel={()=>void stop(execution.id)} busy={cancelling===execution.id}/>)}
    {editing && <form className="surface plan-form" onSubmit={submit}>
      <div className="surface-header"><div><h3>创建测试计划</h3><p>支持 API / Web / Android / Desktop；Android 请先在设备页授权，桌面请选择本机目标窗口。</p></div></div>
      <div className="form-section">
        <p className="form-section-label">基本信息</p>
        <div className="field-grid">
          <label className="field"><span>计划名称</span><input required value={name} onChange={event => setName(event.target.value)} placeholder="例如：发布前冒烟回归" /></label>
          <label className="field"><span>环境名称</span><input required value={environment} onChange={event => setEnvironment(event.target.value)} /></label>
        </div>
      </div>
      <div className="form-section">
        <p className="form-section-label">目标环境</p>
        <div className="field-grid">
          <label className="field"><span>API 基础地址</span><input className="mono-input" value={apiBase} onChange={event => setApiBase(event.target.value)} placeholder="https://api.example.test" /></label>
          <label className="field"><span>API 变量环境</span><select value={apiEnvironmentId} onChange={event=>setApiEnvironmentId(event.target.value)}><option value="">无环境</option>{apiEnvironments.map(item=><option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select><small>就绪时固定环境快照。完整 URL 的 API 节点可不填基础地址。</small></label>
          <label className="field"><span>Web 基础地址</span><input className="mono-input" value={webBase} onChange={event => setWebBase(event.target.value)} placeholder="https://app.example.test" /></label>
          <label className="field"><span>Android 设备 ID</span><input className="mono-input" value={deviceId} onChange={event => setDeviceId(event.target.value)} placeholder="从 Android 设备页复制 UUID" /></label>
          <label className="field"><span>Android App 包名</span><input className="mono-input" value={androidPackage} onChange={event => setAndroidPackage(event.target.value)} placeholder="com.example.app" /></label>
        </div>
        {hasWeb&&<div className="form-section"><p className="form-section-label">Playwright 浏览器</p>
          <label className="check-line"><input type="checkbox" checked={webHeadless} onChange={e=>setWebHeadless(e.target.checked)}/>无头运行（关闭后显示独立 Chromium 窗口）</label>
          <div className="field-grid"><label className="field"><span>浏览器视口宽度</span><input type="number" min="320" max="3840" value={viewportWidth} onChange={e=>setViewportWidth(e.target.value)}/></label><label className="field"><span>浏览器视口高度</span><input type="number" min="240" max="2160" value={viewportHeight} onChange={e=>setViewportHeight(e.target.value)}/></label></div>
        </div>}
        {hasDesktop&&<div className="form-section"><p className="form-section-label">PyAutoGUI 桌面窗口</p>
          <button type="button" className="secondary-button" disabled={fetchingWindows} onClick={()=>void connectLocal()}>{fetchingWindows?'读取中…':'连接本地执行并刷新窗口'}</button>
          <div className="field-grid"><label className="field"><span>桌面目标窗口</span><select required value={windowId} onChange={e=>setWindowId(e.target.value)}><option value="">请选择目标窗口</option>{windows.map(w=><option key={w.hwnd} value={w.hwnd}>{w.title} · PID {w.pid} · {w.screen_width}×{w.screen_height}</option>)}</select></label><label className="field"><span>切回窗口准备时间（秒）</span><input type="number" min="0" max="10" value={desktopDelay} onChange={e=>setDesktopDelay(e.target.value)}/></label></div>
          <p className="quiet-note">点击运行后，请在准备时间内切回目标窗口。支持 Windows 主屏；窗口失焦或被遮挡时停止操作。鼠标移至主屏角落可紧急停止。</p>
        </div>}
        <label className="screenshot-option"><input type="checkbox" checked={hasDesktop||hasAgent&&hasUI||hasUI&&captureScreenshots} disabled={!hasUI||hasDesktop||hasAgent} onChange={event => setCaptureScreenshots(event.target.checked)} />每步截图证据</label>
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
      </div>
      {hasAgent&&<div className="form-section">
          <div className="form-section-label"><span className="form-section-title">模型执行设置</span><button type="button" className="text-button" onClick={()=>void loadModels()}><RotateCcw size={13} />刷新模型配置</button></div>
          <label className="field wide"><span>执行模型</span><select required value={providerId} onChange={e=>setProviderId(e.target.value)}><option value="">请选择已验证模型</option>{models.filter(m=>m.status==='verified'&&m.capabilities.includes('structured_output')&&['openai_chat','openai_responses','anthropic_messages'].includes(m.protocol)&&(!hasDesktop||m.vision_verified)).map(m=><option key={m.id} value={m.id}>{m.name} · {m.vision_verified?'视觉已验证':'文本观察'}</option>)}</select></label>
          <div className="field-grid"><label className="field"><span>每步最大决策轮数</span><input type="number" min="1" max="20" value={rounds} onChange={e=>setRounds(Number(e.target.value))}/></label><label className="field"><span>每用例最大决策轮数</span><input type="number" min="1" max="200" value={caseRounds} onChange={e=>setCaseRounds(Number(e.target.value))}/></label><label className="field"><span>模型超时（秒）</span><input type="number" min="10" max="300" value={modelTimeout} onChange={e=>setModelTimeout(Number(e.target.value))}/></label><label className="field"><span>用例超时（秒）</span><input type="number" min="30" max="1800" value={caseTimeout} onChange={e=>setCaseTimeout(Number(e.target.value))}/></label></div>
        </div>}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={() => setEditing(false)}>取消</button>
        <button type="submit" className="primary-button" disabled={saving || selected.length === 0}>{saving ? '创建中…' : '创建计划'}</button>
      </div>
    </form>}

    <div className="card-list">{plans.length ? paged.items.map(plan => {
      const planRuns = runs.filter(run => run.plan_id === plan.id)
      const lastRun = planRuns[0]
      const planCases = plan.case_ids.map(id => cases.find(item => item.id === id)).filter((item): item is CaseRecord => Boolean(item))
      return <section className="surface plan-card" key={plan.id}>
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
          <div className="plan-actions">{plan.status === 'draft'
            ? <button className="secondary-button" disabled={busy === plan.id} onClick={() => void act(plan.id, onReady)}><ShieldCheck size={15} /> 预检查并就绪</button>
            : <button className="primary-button" disabled={busy === plan.id||executions.some(e=>e.plan_id===plan.id&&['running','stopping'].includes(e.state))} onClick={() => void act(plan.id, run)}><Play size={14} /> {busy === plan.id ? '运行中…' : '运行计划'}</button>}
          </div>
        </div>
      </section>
    }) : <section className="surface"><EmptyState icon={Workflow} title="还没有测试计划" description="选择已批准的用例并配置目标环境，创建第一个计划。" /></section>}</div>
    <Pagination {...paged} />
  </>
}
