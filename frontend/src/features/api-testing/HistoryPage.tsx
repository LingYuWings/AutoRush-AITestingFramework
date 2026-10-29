import {useEffect,useState} from 'react'
import {apiTesting} from './client'
import {runnerApi} from './runner-client'
import type {ApiRun,Page} from './runner-client'
import type {ApiExecution,ApiRequest} from './types'
import ResponsePanel from './ResponsePanel'
import RunDetail from './RunDetail'

export default function HistoryPage({onRestore,onLatest,active=true}:{onRestore:(value:ApiRequest)=>void;onLatest:(run:ApiRun)=>void;active?:boolean}){
  const [mode,setMode]=useState('runs'),[search,setSearch]=useState(''),[status,setStatus]=useState(''),[offset,setOffset]=useState(0)
  const [runs,setRuns]=useState<Page<ApiRun>|null>(null),[history,setHistory]=useState<ApiExecution[]>([]),[selected,setSelected]=useState<string|null>(null)
  const [response,setResponse]=useState<ApiExecution|null>(null),[error,setError]=useState('')
  useEffect(()=>{if(!active)return;let live=true;const timer=setTimeout(()=>{void Promise.all([runnerApi.list(search,status,offset),apiTesting.history()]).then(([r,h])=>{if(live){setRuns(r);setHistory(h)}}).catch(cause=>{if(live)setError(String(cause))})},200);return()=>{live=false;clearTimeout(timer)}},[search,status,offset,mode,active])
  const openResponse=async(id:string)=>{setError('');try{setResponse(await apiTesting.historyDetail(id))}catch(cause){setError(String(cause))}}
  return <section className="api-page"><header className="api-page-heading"><h2>执行历史</h2><p className="muted">仅加载摘要；展开记录后读取脱敏证据。</p></header>{error&&<p role="alert" className="api-error">{error}</p>}
    <div className="api-tabs" role="tablist" aria-label="执行历史分类">{[['runs','集合运行'],['requests','单请求']].map(([key,label])=><button type="button" key={key} role="tab" aria-selected={mode===key} onClick={()=>{setMode(key);setSelected(null);setResponse(null)}}>{label}</button>)}</div>
    <div className="api-toolbar"><input aria-label="搜索执行历史" placeholder="搜索名称、ID、结果或原因" value={search} onChange={event=>{setSearch(event.target.value);setOffset(0)}}/>{mode==='runs'&&<select aria-label="筛选运行状态" value={status} onChange={event=>{setStatus(event.target.value);setOffset(0)}}><option value="">全部状态</option>{[['passed','通过'],['failed','失败'],['error','错误'],['blocked','阻塞'],['running','运行中'],['cancelled','已取消'],['interrupted','已中断']].map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>}</div>
    {mode==='runs'?<><div className="api-run-history">{runs?.items.map(item=><article key={item.id} className="api-resource-card"><button className="api-resource-button" type="button" onClick={()=>setSelected(selected===item.id?null:item.id)}><strong>{item.name}</strong><span>{item.state} · {item.status??'等待结果'} · {item.completed}/{item.total}</span><small>{new Date(item.created_at).toLocaleString()}</small></button>{selected===item.id&&<RunDetail visible={active} id={item.id} onLatest={onLatest} onRun={id=>setSelected(id)}/>}</article>)}</div>{selected&&!runs?.items.some(item=>item.id===selected)&&<RunDetail visible={active} id={selected} onLatest={onLatest} onRun={setSelected}/>}<div className="api-toolbar"><button className="secondary-button" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页</button><span>{runs?.total??0} 条运行</span><button className="secondary-button" disabled={offset+20>=(runs?.total??0)} onClick={()=>setOffset(offset+20)}>下一页</button></div></>:<><div className="api-history">{history.filter(item=>[item.name,item.url,item.method,item.status].join(' ').toLowerCase().includes(search.toLowerCase())).map(item=><button key={item.id} type="button" onClick={()=>item.id&&void openResponse(item.id)}>{item.method} · {item.name} · {item.status}<small>{item.created_at}</small></button>)}</div>{response&&<><ResponsePanel value={response}/><button type="button" className="secondary-button" onClick={()=>void (async()=>{try{const value=await apiTesting.historyRequest(response.id!);onRestore(value.request)}catch(cause){setError(String(cause))}})()}>恢复历史请求到新标签</button></>}</>}
  </section>
}
