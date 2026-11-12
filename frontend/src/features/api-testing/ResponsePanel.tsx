// Present HTTP results in tabs shared by the workbench, Runner and execution reports.
import { uiLanguage, uiText } from '../../shared/i18n.ts'
import {useEffect,useMemo,useRef,useState} from 'react'
import {Copy,Download,Search} from '../../components/icons'
import {statusLabel} from '../../shared/format'
import type {ApiExecution} from './types'
import {downloadText} from './client'
import {searchResponse} from './workbench-format'

// Preserve text responses and indent structured values for display.
const pretty=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2)
const displayLimit=65536
// Show the response body, timing, and outcomes of checks and extractions.
export default function ResponsePanel({value}:{value:ApiExecution|null}){
  const [tab,setTab]=useState('body')
  const [mode,setMode]=useState<'pretty'|'raw'>('pretty')
  const [query,setQuery]=useState(''),[current,setCurrent]=useState(0),[copyNotice,setCopyNotice]=useState('')
  const mark=useRef<HTMLElement>(null)
  const response=value?.response
  const display=mode==='raw'?response?.text??'':pretty(response?.body??'')
  const body=display.slice(0,displayLimit)
  const matches=useMemo(()=>searchResponse(body,query),[body,query])
  const index=matches.length?current%matches.length:0
  const offset=matches[index]
  useEffect(()=>{mark.current?.scrollIntoView({block:'nearest'})},[offset,query,tab,mode])
  if(!value)return <section className="api-response" aria-label={uiText('API 响应')}>
    <div className="api-response-heading"><strong>{uiText('响应')}</strong></div>
    <p className="api-empty">{uiText('发送请求后，在此查看响应、耗时、断言和提取结果。')}</p>
  </section>
  const headers=Object.entries(response?.headers??{})
  const cookies=Array.isArray(response?.cookie_names)?response.cookie_names:[]
  const httpStatus=response?.status_code??0
  const statusTone=httpStatus>=400?'failed':httpStatus>=300?'blocked':httpStatus>=200?'passed':'skipped'
  // Copy the same sanitized body shown in the selected view.
  const copyBody=async()=>{
    try{await navigator.clipboard.writeText(display);setCopyNotice(uiText('已复制响应正文'))}
    catch{setCopyNotice(uiText('无法复制响应正文'))}
  }
  return <section className="api-response" aria-label={uiText("API 响应")}>
    <div className="api-response-heading">
      <div className="api-tabs" role="tablist" aria-label={uiText('响应视图')}>
        {[
          ['body',uiText('正文')],['cookies',`Cookies (${cookies.length})`],['headers',uiText('响应头')+` (${headers.length})`],
          ['assertions',uiText('测试结果 ({0})',value.assertions?.length??0)],['extracted',uiText('提取值')],
        ].map(([key,label])=><button key={key} type="button" role="tab" aria-selected={tab===key} onClick={()=>setTab(key)}>{label}</button>)}
      </div>
      <div className="api-response-metrics"><strong className={`api-status-${response?statusTone:value.status}`}>{response?`${httpStatus}${response.reason_phrase?' '+response.reason_phrase:''}`:statusLabel[value.status]}</strong>
        {response&&<span className={`api-status-${value.status}`}>{statusLabel[value.status]}</span>}
        <span className="mono">{value.elapsed_ms?.toFixed(1)} ms</span>{response&&<span className="mono">{response.bytes.toLocaleString(uiLanguage)} B</span>}
      </div>
    </div>
    <p className="api-response-detail">{value.detail}</p>
    <p className="api-response-detail mono">{value.method} {value.response?.url??value.url}</p>
    {response?.history_truncated&&<p className="quiet-note">{uiText("历史记录保留了正文摘要，完整响应已超出历史保存上限。")}</p>}
    {tab==='body'&&<>
      <div className="api-response-tools">
        <div className="segmented" role="group" aria-label={uiText('正文格式')}>{(['pretty','raw'] as const).map(option=><button key={option} type="button" className={mode===option?'active':''} aria-pressed={mode===option} onClick={()=>{setMode(option);setCurrent(0);setCopyNotice('')}}>{option==='pretty'?'Pretty':'Raw'}</button>)}</div>
        <label className="api-response-search"><Search size={14}/><input type="search" aria-label={uiText('搜索响应正文')} placeholder={uiText('搜索响应正文')} value={query} onChange={event=>{setQuery(event.target.value);setCurrent(0)}} onKeyDown={event=>{if(event.key==='Enter'&&matches.length){event.preventDefault();setCurrent((index+(event.shiftKey?-1:1)+matches.length)%matches.length)}}}/></label>
        {query&&<><span className="mono" role="status">{matches.length?index+1:0}/{matches.length}</span><button type="button" className="icon-button" disabled={!matches.length} aria-label={uiText('上一个匹配项')} onClick={()=>setCurrent((index-1+matches.length)%matches.length)}>↑</button><button type="button" className="icon-button" disabled={!matches.length} aria-label={uiText('下一个匹配项')} onClick={()=>setCurrent((index+1)%matches.length)}>↓</button></>}
        <button type="button" className="icon-button" disabled={!response} aria-label={uiText('复制响应正文')} title={uiText('复制响应正文')} onClick={()=>void copyBody()}><Copy size={15}/></button>
        <button type="button" className="icon-button" aria-label={uiText('下载结果')} title={uiText('下载结果')} onClick={()=>downloadText('api-response.json',JSON.stringify(value,null,2))}><Download size={15}/></button>
        {copyNotice&&<small role="status">{copyNotice}</small>}
      </div>
      <pre className="api-response-body mono">{offset===undefined?body:<>{body.slice(0,offset)}<mark ref={mark}>{body.slice(offset,offset+query.length)}</mark>{body.slice(offset+query.length)}</>}{display.length>displayLimit?uiText('\n…界面仅显示前 64 KiB，可下载结果查看。'):''}</pre>
    </>}
    {tab==='headers'&&<dl className="api-response-headers">{headers.map(([key,item])=><div key={key}><dt>{key}</dt><dd>{item}</dd></div>)}</dl>}
    {tab==='cookies'&&<div className="api-response-cookies">{cookies.length?<><p className="quiet-note">{uiText('仅显示本次响应设置的 Cookie 名称，值已隐藏。')}</p><ul>{cookies.map((name,index)=><li key={index}><code>{name}</code></li>)}</ul></>:<p className="quiet-note">{uiText('没有可查看的响应 Cookie。')}</p>}</div>}
    {tab==='extracted'&&<pre className="api-response-body mono">{pretty(value.extracted??{}).slice(0,displayLimit)}</pre>}
    {tab==='assertions'&&<ul className="api-checks">{value.assertions?.map((item,index)=><li key={index} className={item.passed?'api-status-passed':'api-status-failed'}>{item.passed?'✓':'×'} {item.detail}</li>)}{!value.assertions?.length&&<li>{uiText('没有配置断言。')}</li>}</ul>}
  </section>
}

// Expand a stored API result on demand in a run report.
export function ApiEvidence({value}:{value:unknown}){
  const [open,setOpen]=useState(false)
  if(!value||typeof value!=='object')return null
  return <details className="api-report-evidence" onToggle={event=>setOpen(event.currentTarget.open)}><summary>{uiText("HTTP 执行证据")}</summary>{open&&<ResponsePanel value={value as ApiExecution}/>}</details>
}
