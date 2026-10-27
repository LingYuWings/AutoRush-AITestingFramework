import {useEffect,useState} from 'react'
import {apiTesting} from './client'
import type {ApiRequest,ApiRequestRecord,CollectionRecord} from './types'
import {configuration,newRequest} from './types'
import RequestEditor from './RequestEditor'
import './api-testing.css'

export default function ApiNodeCard({parameters,intent,index,cleanup,alwaysRun,onChange,onIntent,onRemove,onAlwaysRun,onMoveUp,onMoveDown}:{parameters:Record<string,unknown>;intent:string;index:number;cleanup?:boolean;alwaysRun:boolean;onChange:(value:Record<string,unknown>)=>void;onIntent:(value:string)=>void;onRemove:()=>void;onAlwaysRun:(value:boolean)=>void;onMoveUp?:()=>void;onMoveDown?:()=>void}){
  const [draft,setDraft]=useState<ApiRequest|null>(parameters.request?parameters.request as ApiRequest:parameters.request_snapshot_id?null:newRequest())
  const [requests,setRequests]=useState<ApiRequestRecord[]>([]),[collections,setCollections]=useState<CollectionRecord[]>([])
  const [inherited,setInherited]=useState<unknown[]>([]),[error,setError]=useState('')
  useEffect(()=>{let live=true;void Promise.all([apiTesting.requests(),apiTesting.collections()]).then(([r,c])=>{if(live){setRequests(r);setCollections(c)}}).catch(cause=>{if(live)setError(String(cause))});if(parameters.request_snapshot_id&&!parameters.request)void apiTesting.getSnapshot(String(parameters.request_snapshot_id)).then(record=>{if(live){setDraft(record.request);setInherited(record.collection_variables)}}).catch(cause=>{if(live)setError(String(cause))});return()=>{live=false}},[])
  const edit=(request:ApiRequest)=>{setDraft(request);onChange({request,collection_variables:inherited,source_request_id:parameters.source_request_id,source_version:parameters.source_version})}
  return <section className="surface step-card api-node-card"><div className="section-title"><strong>{cleanup?'后处理':'执行步骤'} {index+1} · API 节点</strong><div className="api-toolbar"><button type="button" className="text-button" disabled={!onMoveUp} onClick={onMoveUp}>上移</button><button type="button" className="text-button" disabled={!onMoveDown} onClick={onMoveDown}>下移</button><button type="button" className="secondary-button" onClick={onRemove}>删除 API 节点</button></div></div>
    <label className="field"><span>操作意图</span><input value={intent} required onChange={e=>onIntent(e.target.value)}/></label>
    <label className="field"><span>复用已保存的请求</span><select aria-label="复用已保存的请求" value="" onChange={e=>{const record=requests.find(item=>item.id===e.target.value);if(record){const value=configuration(record);setDraft(value);setInherited([]);onChange({request:value,source_request_id:record.id,source_version:record.version})}}}><option value="">选择请求，或在下方独立填写</option>{requests.map(item=><option key={item.id} value={item.id}>{item.method} · {item.name} · v{item.version}</option>)}</select></label>
    {error&&<p role="alert" className="api-error">{error}</p>}
    {draft?<RequestEditor value={draft} collections={collections} onChange={edit}/>:<p className="muted">正在读取加密请求快照…</p>}
    <p className="quiet-note">保存用例时会固定请求配置快照，后续编辑集合不会影响本用例。此节点确定性执行，不消耗模型轮数。</p>
    {cleanup&&<label className="check-line"><input type="checkbox" checked={alwaysRun} onChange={e=>onAlwaysRun(e.target.checked)}/>前序失败后仍执行</label>}
  </section>
}
