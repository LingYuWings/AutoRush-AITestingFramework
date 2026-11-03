import {useEffect,useRef,useState} from 'react'
import ResponsePanel from './ResponsePanel'
import {runnerApi,runActive} from './runner-client'
import type {ApiRun,Page,RunStep} from './runner-client'

const labels:Record<string,string>={queued:'排队中',running:'运行中',cancelling:'正在停止',completed:'已完成',cancelled:'已取消',interrupted:'已中断',passed:'通过',failed:'失败',error:'错误',blocked:'阻塞',skipped:'跳过'}
export default function RunDetail({id,onLatest,onRun,onChange,visible=true}:{id:string;onLatest:(run:ApiRun)=>void;onRun:(id:string)=>void;onChange?:(run:ApiRun)=>void;visible?:boolean}){
  const [run,setRun]=useState<ApiRun|null>(null),[steps,setSteps]=useState<Page<RunStep>|null>(null),[offset,setOffset]=useState(0)
  const [open,setOpen]=useState<number|null>(null),[detail,setDetail]=useState<RunStep|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [pollError,setPollError]=useState(''),[pollPaused,setPollPaused]=useState(false),[pollEpoch,setPollEpoch]=useState(0)
  const onChangeRef=useRef(onChange);onChangeRef.current=onChange
  const retryPolling=()=>setPollEpoch(epoch=>epoch+1)
  useEffect(()=>{setOffset(0);setOpen(null);setDetail(null);setRun(null);setSteps(null);setError('')},[id])
  useEffect(()=>{
    if(!visible)return
    const abort=new AbortController()
    let timer:ReturnType<typeof setTimeout>|undefined,lastCount=-1,failures=0
    setPollError('');setPollPaused(false)
    async function update(){
      if(abort.signal.aborted)return
      if(document.hidden){timer=setTimeout(()=>void update(),2000);return}
      try{
        const value=await runnerApi.get(id,abort.signal)
        if(abort.signal.aborted)return
        setRun(value);onChangeRef.current?.(value)
        if(lastCount!==value.completed){
          const page=await runnerApi.steps(id,offset,abort.signal)
          if(abort.signal.aborted)return
          setSteps(page);lastCount=value.completed
        }
        failures=0;setPollError('')
        if(runActive(value))timer=setTimeout(()=>void update(),1000)
      }catch(cause){
        if(abort.signal.aborted)return
        setPollError(String(cause))
        failures+=1
        if(failures<=5)timer=setTimeout(()=>void update(),Math.min(1000*2**(failures-1),8000))
        else setPollPaused(true)
      }
    }
    void update();return()=>{abort.abort();if(timer)clearTimeout(timer)}
  },[id,offset,visible,pollEpoch])
  useEffect(()=>{const abort=new AbortController();setDetail(null);if(open!==null&&visible)void runnerApi.detail(id,open,abort.signal).then(value=>{if(!abort.signal.aborted)setDetail(value)}).catch(cause=>{if(!abort.signal.aborted)setError(String(cause))});return()=>abort.abort()},[id,open,visible])
  const action=async(callback:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await callback()}catch(cause){setError(String(cause))}finally{setBusy(false)}}
  const pollFeedback=pollError&&<p role="alert" className="api-error">{pollError}{' '}{pollPaused
    ?<button type="button" className="text-button" onClick={retryPolling}>重新读取状态</button>
    :'正在重新读取运行状态…'}</p>
  if(!run)return <section aria-busy={!pollPaused}>{pollFeedback||error||'正在读取运行记录…'}</section>
  return <section className="api-run-detail" aria-label="集合运行详情"><header className="api-page-heading"><div><h3>{run.name}</h3><p className="mono">{run.id}</p></div><strong>{labels[run.state]} · {run.status?labels[run.status]:'等待结果'}</strong></header>
    {pollFeedback}{error&&<p role="alert" className="api-error">{error}</p>}<div className="api-run-progress" role="status">已执行 {run.completed} / {run.total} · {run.elapsed_ms.toFixed(0)} ms{run.current_request?` · 第 ${run.current_iteration} 轮：${run.current_request}`:''}</div><progress max={Math.max(1,run.total)} value={run.completed}/>
    <div className="api-run-counts">{Object.entries(run.counts).map(([key,value])=><span className={`api-status-${key}`} key={key}>{labels[key]} {value}</span>)}</div>{run.detail&&<p className="api-warning">{run.detail}</p>}
    <p className="quiet-note">环境：{run.source.environment_name??'无'} · {run.source.iterations} 次迭代 · {run.source.dataset_row_count} 行数据 · 请求前延迟 {run.source.delay_ms} ms · {run.source.stop_on_failure?'失败即停止':'失败后继续'}。配置已冻结，后续编辑不改变本次记录。</p>
    <div className="api-toolbar">{runActive(run)?<button className="secondary-button" disabled={busy||run.state==='cancelling'} onClick={()=>void action(async()=>{setRun(await runnerApi.cancel(id));retryPolling()})}>取消运行</button>:<><button className="primary-button" disabled={busy} onClick={()=>void action(async()=>{const next=await runnerApi.rerun(id);onRun(next.id)})}>按原快照重新运行</button><button className="secondary-button" disabled={busy} onClick={()=>onLatest(run)}>按最新配置运行</button></>}{(['json','html','junit'] as const).map(format=><button key={format} className="text-button" disabled={busy} onClick={()=>void action(()=>runnerApi.download(id,format))}>下载 {format.toUpperCase()}</button>)}</div>
    <div className="api-run-steps">{steps?.items.map(step=><article key={step.seq} className="api-run-step"><button className="api-step-summary" type="button" aria-expanded={open===step.seq} onClick={()=>setOpen(open===step.seq?null:step.seq)}><span>第 {step.iteration} 轮 · {step.seq+1}. {step.name}</span><span className={`api-status-${step.status}`}>{labels[step.status]} · {step.elapsed_ms.toFixed(0)} ms</span></button>{open===step.seq&&(detail?<><ResponsePanel value={detail}/>{detail.response_omitted&&<p className="api-warning">{detail.response_omitted}</p>}</>:<p className="quiet-note">读取请求证据…</p>)}</article>)}</div>
    {run.completed===0&&<p className="quiet-note">还没有已完成的请求。未执行请求不会被重放。</p>}<div className="api-toolbar"><button className="secondary-button" disabled={offset===0} onClick={()=>{setOpen(null);setOffset(Math.max(0,offset-25))}}>上一页</button><span>{offset+1}–{Math.min(offset+25,steps?.total??0)} / {steps?.total??0}</span><button className="secondary-button" disabled={offset+25>=(steps?.total??0)} onClick={()=>{setOpen(null);setOffset(offset+25)}}>下一页</button></div>
  </section>
}
