import { uiText } from '../../shared/i18n.ts'
import {useEffect,useRef,useState} from 'react'
import {apiTesting} from './client'
import type {ApiRequest,ApiRequestRecord,CollectionRecord} from './types'
import {configuration,newRequest} from './types'
import RequestEditor from './RequestEditor'
import StepHeading from '../cases/StepHeading'
import './api-testing.css'

// Edit an API request embedded as a step in a test case.
export default function ApiNodeCard({parameters,intent,index,cleanup,alwaysRun,onChange,onIntent,onRemove,onAlwaysRun,onMoveUp,onMoveDown}:{parameters:Record<string,unknown>;intent:string;index:number;cleanup?:boolean;alwaysRun:boolean;onChange:(value:Record<string,unknown>)=>void;onIntent:(value:string)=>void;onRemove:()=>void;onAlwaysRun:(value:boolean)=>void;onMoveUp?:()=>void;onMoveDown?:()=>void}){
  const [draft,setDraft]=useState<ApiRequest|null>(parameters.request?parameters.request as ApiRequest:parameters.request_snapshot_id?null:newRequest())
  const [requests,setRequests]=useState<ApiRequestRecord[]>([]),[collections,setCollections]=useState<CollectionRecord[]>([])
  const [inherited,setInherited]=useState<unknown[]>(()=>Array.isArray(parameters.collection_variables)?parameters.collection_variables:[])
  const [error,setError]=useState(''),[editorScope,setEditorScope]=useState(0)
  const selection=useRef(0)
  const snapshotId=!parameters.request&&parameters.request_snapshot_id?String(parameters.request_snapshot_id):null
  useEffect(()=>{let live=true;void Promise.all([apiTesting.requests(),apiTesting.collections()]).then(([r,c])=>{if(live){setRequests(r);setCollections(c)}}).catch(cause=>{if(live)setError(String(cause))});return()=>{live=false}},[])
  useEffect(()=>{
    if(!snapshotId)return
    let live=true
    const generation=selection.current
    void apiTesting.getSnapshot(snapshotId).then(record=>{
      if(live&&selection.current===generation){setDraft(record.request);setInherited(record.collection_variables)}
    }).catch(cause=>{if(live&&selection.current===generation)setError(String(cause))})
    return()=>{live=false}
  },[snapshotId])
  // Copy a saved request into the step and preserve its source metadata.
  const choose=(id:string)=>{
    const record=requests.find(item=>item.id===id)
    if(!record)return
    selection.current++
    const value=configuration(record)
    setEditorScope(scope=>scope+1);setDraft(value);setInherited([]);setError('')
    onChange({request:value,source_request_id:record.id,source_version:record.version})
  }
  // Update the step's request while preserving its collection variables and source.
  const edit=(request:ApiRequest)=>{setDraft(request);onChange({request,collection_variables:inherited,source_request_id:parameters.source_request_id,source_version:parameters.source_version})}
  return <section className="step-card api-node-card">
    <StepHeading index={index} cleanup={cleanup} title={cleanup?uiText("后处理 · API 节点"):uiText("API 节点")} driver="api" onMoveUp={onMoveUp} onMoveDown={onMoveDown} onRemove={onRemove}/>
    <div className="field-grid"><label className="field"><span>{uiText("操作意图")}</span><input value={intent} required onChange={e=>onIntent(e.target.value)}/></label>
    <label className="field"><span>{uiText("复用已保存的请求")}</span><select aria-label={uiText("复用已保存的请求")} value="" onChange={e=>choose(e.target.value)}><option value="">{uiText("选择请求，或在下方独立填写")}</option>{requests.map(item=><option key={item.id} value={item.id}>{item.method} · {item.name} · v{item.version}</option>)}</select></label></div>
    {error&&<p role="alert" className="inline-alert error">{error}</p>}
    <div className="api-node-request">{draft?<RequestEditor key={editorScope} value={draft} collections={collections} onChange={edit}/>:<p className="quiet-note">{uiText("正在读取加密请求快照…")}</p>}</div>
    <p className="quiet-note">{uiText("保存用例时会固定请求配置快照，后续编辑集合不会影响本用例。此节点确定性执行，不消耗模型轮数。")}</p>
    {cleanup&&<label className="check-line"><input type="checkbox" checked={alwaysRun} onChange={e=>onAlwaysRun(e.target.checked)}/>{uiText("前序步骤失败后仍执行")}</label>}
  </section>
}
