import {useState} from 'react'
import {statusLabel} from '../../shared/format'
import type {ApiExecution} from './types'
import {downloadText} from './client'

const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2)
export default function ResponsePanel({value}:{value:ApiExecution|null}){
  const [tab,setTab]=useState('body')
  if(!value)return <section className="api-response api-empty">发送请求后，在此查看响应、耗时、断言和提取结果。</section>
  const response=value.response
  const display=tab==='body'?pretty(response?.body??''):tab==='raw'?response?.text??'':tab==='headers'?pretty(response?.headers??{}):pretty(value.extracted??{})
  return <section className="api-response" aria-label="API 响应">
    <div className="api-response-heading"><strong className={`api-status api-status-${value.status}`}>{statusLabel[value.status]}{response?` · HTTP ${response.status_code}`:''}</strong><span className="mono">{value.elapsed_ms?.toFixed(1)} ms{response?` · ${response.bytes.toLocaleString()} bytes`:''}</span><button type="button" className="text-button" onClick={()=>downloadText('api-response.json',JSON.stringify(value,null,2))}>下载结果</button></div>
    <p className="api-response-detail">{value.detail}</p>
    <p className="api-response-detail mono">{value.method} {value.response?.url??value.url}</p>
    <div className="api-tabs" role="tablist" aria-label="响应视图">{[['body','Pretty'],['raw','Raw'],['headers','响应头'],['assertions',`断言 (${value.assertions?.length??0})`],['extracted','提取值']].map(([key,label])=><button key={key} type="button" role="tab" aria-selected={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    {response?.history_truncated&&<p className="quiet-note">历史记录保留了正文摘要，完整响应已超出历史保存上限。</p>}
    {tab==='assertions'?<ul className="api-checks">{value.assertions?.map((item,index)=><li key={index} className={item.passed?'api-status-passed':'api-status-failed'}>{item.passed?'✓':'×'} {item.detail}</li>)}{!value.assertions?.length&&<li>没有配置断言。</li>}</ul>:<pre className="api-response-body mono">{(display??'').slice(0,65536)}{(display?.length??0)>65536?'\n…界面仅显示前 64 KiB，可下载结果查看。':''}</pre>}
  </section>
}

export function ApiEvidence({value}:{value:unknown}){
  const [open,setOpen]=useState(false)
  if(!value||typeof value!=='object')return null
  return <details className="api-report-evidence" onToggle={event=>setOpen(event.currentTarget.open)}><summary>HTTP 执行证据</summary>{open&&<ResponsePanel value={value as ApiExecution}/>}</details>
}
