import {useEffect,useRef,useState} from 'react'
import {Play,RefreshCw,X} from '../../components/icons'
import {api,type DesktopTarget,type PlanRecord,type ProviderConfig} from '../../shared/api'
import {apiTesting} from '../api-testing/client'
import type {CollectionRecord} from '../api-testing/types'
import {debugClient,type DebugCase,type DebugRun,type DebugSelection,type DebugSummary} from './client'
import {debugTargets,initialDebugForm,validateDebugCase,type DebugForm} from './form'
import CaseDebugResults from './CaseDebugResults'
import './case-debug.css'

// Configure and monitor a debug run for the selected case snapshot.
export default function CaseDebugPanel({open,selection,plans,onClose}:{open:boolean;selection:DebugSelection|null;plans:PlanRecord[];onClose:()=>void}){
  const [form,setForm]=useState(initialDebugForm),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [run,setRun]=useState<DebugRun|null>(null),[history,setHistory]=useState<DebugSummary[]>([])
  const [activeRun,setActiveRun]=useState<DebugRun|null>(null)
  const [models,setModels]=useState<ProviderConfig[]>([]),[environments,setEnvironments]=useState<CollectionRecord[]>([]),[devices,setDevices]=useState<string[]>([]),[windows,setWindows]=useState<DesktopTarget[]>([])
  const [onlyCurrent,setOnlyCurrent]=useState(true),[ready,setReady]=useState(false),[loadingWindows,setLoadingWindows]=useState(false)
  const retry=useRef<{content:string;key:string}|null>(null)
  const pollFailures=useRef(0)
  const [pollTick,setPollTick]=useState(0)
  const [connectionTick,setConnectionTick]=useState(0)
  const generation=useRef(0)
  const viewGeneration=useRef(0)
  const scopeRef=useRef({selection,onlyCurrent});scopeRef.current={selection,onlyCurrent}
  // Change one debug input without resetting the rest of the form.
  const update=<K extends keyof DebugForm>(key:K,value:DebugForm[K])=>setForm(old=>({...old,[key]:value}))
  let draft:DebugCase|undefined;try{draft=selection?.read?.()}catch{/* Validation is shown when Run is clicked. */}
  const drivers=new Set(draft?[...draft.steps,...draft.postconditions].map(s=>s.driver):[])
  const active=Boolean(activeRun&&['running','stopping'].includes(activeRun.state))
  // Reload debug history for the current case or session and ignore stale results.
  const refreshHistory=async()=>{
    const token=generation.current
    const {selection:source,onlyCurrent:scoped}=scopeRef.current
    const rows=await debugClient.list(scoped?source?.source?.id:undefined,scoped&&!source?.source?source?.sessionId:undefined)
    if(token===generation.current)setHistory(rows);return rows
  }
  useEffect(()=>{
    if(!open)return
    let disposed=false
    const token=++generation.current
    const viewToken=++viewGeneration.current
    setError('');setReady(false)
    void debugClient.authorize(true).then(async()=>{
      const [providers,env,phones,rows,activeRows]=await Promise.all([api.providerConfigs(),apiTesting.environments(),api.devices(),debugClient.list(onlyCurrent?selection?.source?.id:undefined,onlyCurrent&&!selection?.source?selection?.sessionId:undefined),debugClient.active()])
      const [latest,current]=await Promise.all([rows[0]?debugClient.get(rows[0].id):null,activeRows[0]?debugClient.get(activeRows[0].id):null])
      if(disposed||token!==generation.current)return
      setModels(providers);setEnvironments(env);setDevices(phones.devices);setHistory(rows);setReady(true)
      setActiveRun(current)
      if(viewToken===viewGeneration.current)setRun(latest??current)
    }).catch(cause=>{if(!disposed)setError(String(cause))})
    return()=>{disposed=true}
  },[open,selection,onlyCurrent,connectionTick])
  useEffect(()=>{
    if(!active||!activeRun)return
    let disposed=false
    const timer=window.setTimeout(()=>{void debugClient.get(activeRun.id).then(value=>{if(!disposed){pollFailures.current=0;setError('');setActiveRun(current=>current?.id===value.id?value:current);setRun(current=>current?.id===value.id?value:current);if(!['running','stopping'].includes(value.state))void refreshHistory().catch(cause=>setError(String(cause)))}}).catch(cause=>{if(!disposed){pollFailures.current++;setError('调试状态暂不可用，正在重试：'+String(cause));setPollTick(value=>value+1)}})},Math.min(4000,1000*2**Math.min(pollFailures.current,2)))
    return()=>{disposed=true;window.clearTimeout(timer)}
  },[activeRun,active,pollTick])
  // Validate the case and runtime targets before starting a debug run.
  const start=async()=>{
    if(!selection?.read||busy||active)return
    setBusy(true);setError('');++viewGeneration.current
    try{
      const value=validateDebugCase(selection.read())
      const payload={...(selection.saved?{}:{case:value}),...(selection.source?{source_case_id:selection.source.id,source_version:selection.source.version}:{}),session_id:selection.sessionId,targets:debugTargets(form,value)}
      const content=JSON.stringify(payload)
      if(retry.current?.content!==content)retry.current={content,key:crypto.randomUUID()}
      await debugClient.authorize()
      const started=await debugClient.start({...payload,idempotency_key:retry.current.key})
      setRun(started);setActiveRun(started);retry.current=null
      await refreshHistory()
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause))}finally{setBusy(false)}
  }
  // Cancel the active debug run and reconcile its returned state.
  const stop=async()=>{
    if(!activeRun||!active||busy)return
    setBusy(true);setError('')
    try{const value=await debugClient.cancel(activeRun.id);setActiveRun(current=>current?.id===value.id?value:current);setRun(current=>current?.id===value.id?value:current)}
    catch(cause){setError(String(cause))}finally{setBusy(false)}
  }
  // Obtain local authorization and refresh available desktop targets.
  const loadWindows=async()=>{
    setLoadingWindows(true);setError('');update('desktopTarget',null)
    try{await debugClient.authorize();const capability=await api.automationCapabilities();if(!capability.desktop.available)throw new Error(capability.desktop.reason??'桌面执行不可用');setWindows((await api.desktopWindows()).windows)}catch(cause){setWindows([]);setError(String(cause))}finally{setLoadingWindows(false)}
  }
  // Prefill debug inputs from a saved test plan.
  const copyPlan=(id:string)=>{
    const plan=plans.find(p=>p.id===id);if(!plan)return
    setForm({...initialDebugForm(),apiBase:plan.api_base_url??'',apiEnvironmentId:plan.api_environment_id??'',webBase:plan.web_base_url??'',deviceId:plan.android_device_id??'',androidPackage:plan.android_package??'',webHeadless:plan.web_headless,viewportWidth:String(plan.web_viewport?.width??1280),viewportHeight:String(plan.web_viewport?.height??800),desktopDelay:String(plan.desktop_start_delay_seconds??3),providerId:plan.agent_options?.provider_config_id??'',rounds:plan.agent_options?.max_rounds_per_step??8,caseRounds:plan.agent_options?.max_rounds_per_case??40,modelTimeout:plan.agent_options?.model_timeout_seconds??90,caseTimeout:plan.agent_options?.case_timeout_seconds??180})
    setWindows([])
  }
  const compatiblePlans=plans.filter(p=>!draft||[...drivers].every(d=>d==='api'||d==='web'&&p.web_base_url||d==='android'&&p.android_device_id||d==='desktop'&&p.desktop_target))
  return <aside className="case-debug-panel" hidden={!open} role="region" aria-label="单用例运行调试">
    <header className="debug-heading"><div><h2>单用例运行调试</h2><p>运行当前快照，不保存、批准用例或创建正式计划。</p></div><button className="icon-button" aria-label="关闭调试面板" onClick={onClose}><X size={18}/></button></header>
    <div className="debug-scroll">
      {error&&<div role="alert" className="inline-alert error">{error}<button className="text-button" onClick={()=>setConnectionTick(value=>value+1)}>重新连接调试服务</button></div>}
      {active&&activeRun&&<section className="debug-active-bar" aria-label="活动调试任务"><p role="status">正在调试：{activeRun.title}</p><div className="debug-actions"><button className="secondary-button" onClick={()=>{++viewGeneration.current;setRun(activeRun)}}>查看运行进度</button><button className="secondary-button" disabled={busy||activeRun.state==='stopping'} onClick={()=>void stop()}>停止调试</button></div></section>}
      {selection?.read&&<section className="debug-config"><p><strong>{draft?.title||'未命名用例'}</strong> · {selection.saved?`已保存 v${selection.source?.version}`:'未保存内容'}</p>
        <label className="field"><span>从已有计划填充配置</span><select defaultValue="" onChange={e=>copyPlan(e.target.value)}><option value="">手动配置</option>{compatiblePlans.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {drivers.has('api')&&<div className="field-grid"><label className="field"><span>API 基础地址</span><input className="mono-input" value={form.apiBase} onChange={e=>update('apiBase',e.target.value)} placeholder="完整 URL 请求可留空"/></label><label className="field"><span>API 变量环境</span><select value={form.apiEnvironmentId} onChange={e=>update('apiEnvironmentId',e.target.value)}><option value="">无环境</option>{environments.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label></div>}
        {drivers.has('web')&&<><label className="field"><span>Web 基础地址</span><input className="mono-input" value={form.webBase} onChange={e=>update('webBase',e.target.value)} placeholder="http://127.0.0.1:8765"/></label><div className="field-grid">{(['viewportWidth','viewportHeight'] as const).map((key,i)=><label key={key} className="field"><span>{i?'浏览器视口高度':'浏览器视口宽度'}</span><input type="number" min={i?240:320} max={i?2160:3840} value={form[key]} onChange={e=>update(key,e.target.value)}/></label>)}</div><label className="check-line"><input type="checkbox" checked={form.webHeadless} onChange={e=>update('webHeadless',e.target.checked)}/>无头运行（关闭后显示独立 Chromium 窗口）</label></>}
        {drivers.has('android')&&<div className="field-grid"><label className="field"><span>在线配对手机</span><select value={form.deviceId} onChange={e=>update('deviceId',e.target.value)}><option value="">请选择设备</option>{devices.map(id=><option key={id}>{id}</option>)}</select></label><label className="field"><span>Android App 包名</span><input className="mono-input" value={form.androidPackage} onChange={e=>update('androidPackage',e.target.value)} placeholder="com.example.app"/></label></div>}
        {drivers.has('desktop')&&<><button className="secondary-button" disabled={loadingWindows} onClick={()=>void loadWindows()}><RefreshCw size={14} className={loadingWindows?'spinning':''}/>{loadingWindows?'读取中…':'刷新桌面窗口'}</button><label className="field"><span>桌面目标窗口</span><select value={form.desktopTarget?.hwnd??''} onChange={e=>update('desktopTarget',windows.find(w=>String(w.hwnd)===e.target.value)??null)}><option value="">请选择当前目标窗口</option>{windows.map(w=><option key={w.hwnd} value={w.hwnd}>{w.title} · PID {w.pid}</option>)}</select></label><label className="field"><span>切回窗口准备时间（秒）</span><input type="number" min="0" max="10" value={form.desktopDelay} onChange={e=>update('desktopDelay',e.target.value)}/></label><p className="quiet-note">运行后在准备时间内切回所选窗口，保留失焦与遮挡保护。</p></>}
        {draft?.execution_mode==='agent'&&<><label className="field"><span>执行模型</span><select value={form.providerId} onChange={e=>update('providerId',e.target.value)}><option value="">请选择已验证模型</option>{models.filter(m=>m.status==='verified'&&m.capabilities.includes('structured_output')&&(!drivers.has('desktop')||m.vision_verified)).map(m=><option key={m.id} value={m.id}>{m.name} · {m.model_id}</option>)}</select></label><div className="field-grid">{([['rounds','每步最大轮数',1,20],['caseRounds','每用例最大轮数',1,200],['modelTimeout','模型超时（秒）',10,300],['caseTimeout','用例超时（秒）',30,1800]] as const).map(([key,label,min,max])=><label className="field" key={key}><span>{label}</span><input type="number" min={min} max={max} value={form[key]} onChange={e=>update(key,Number(e.target.value))}/></label>)}</div></>}
        {[...drivers].some(d=>d!=='api')&&<p className="quiet-note">UI 调试保存压缩截图；截图按需加载，Android 仍需手机本机截图许可。</p>}
        <div className="debug-actions"><button className="primary-button" disabled={!ready||busy||active} onClick={()=>void start()}><Play size={14}/>{busy?'启动中…':active?'调试进行中':'运行当前用例'}</button></div>
      </section>}
      <section className="debug-history"><div className="section-title"><h3>最近调试</h3><button className="text-button" onClick={()=>void refreshHistory().catch(cause=>setError(String(cause)))}><RefreshCw size={13}/>刷新记录</button></div>
        <label className="check-line"><input type="checkbox" checked={onlyCurrent} disabled={!selection?.read} onChange={e=>setOnlyCurrent(e.target.checked)}/>仅当前用例 / 编辑会话</label>
        <select className="mini-select" aria-label="选择调试记录" value={history.some(h=>h.id===run?.id)?run!.id:''} onChange={e=>{const id=e.target.value;if(!id)return;const token=++viewGeneration.current;void debugClient.get(id).then(value=>{if(token===viewGeneration.current)setRun(value)}).catch(cause=>setError(String(cause)))}}><option value="">最近 20 条调试记录</option>{history.map(h=><option key={h.id} value={h.id}>{new Date(h.created_at).toLocaleTimeString()} · {h.title} · {h.status??h.state}</option>)}</select>
      </section>
      {run&&<CaseDebugResults run={run}/>}
    </div>
  </aside>
}
