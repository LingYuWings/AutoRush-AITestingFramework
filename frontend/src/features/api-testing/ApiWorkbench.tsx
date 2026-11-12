import { uiLanguage, uiText } from '../../shared/i18n.ts'
import {useEffect,useRef,useState} from 'react'
import {api} from '../../shared/api'
import {Download,RefreshCw} from '../../components/icons'
import {apiTesting,authorizeApi,downloadText} from './client'
import type {ApiExecution,ApiRequest,ApiRequestRecord,CollectionRecord,CollectionResult,FolderRecord} from './types'
import {configuration,newRequest} from './types'
import RequestEditor from './RequestEditor'
import ResponsePanel from './ResponsePanel'
import ConfigEditor from './ConfigEditor'
import CollectionTree,{type RunScope} from './CollectionTree'
import {loadApiResources,type ApiResources} from './resources'
import './api-testing.css'

export type WorkbenchController={save:()=>Promise<boolean>;saveCopy:()=>Promise<boolean>;abort:()=>void}
export type TabStatus={name:string;method:string;sourceId:string|null;dirty:boolean;busy:boolean}
// Coordinate API request editing, execution, saving, and response inspection.
export default function ApiWorkbench({onCaseCreated,initialRequest,initialDraft,initialDirty=false,workspace=false,onOpenRequest,onNewDraft,onStatus,onController,onRun,onDeleteRequest,onPrepareCase,epoch=0,resources,refreshResources}:{
  onCaseCreated:(id:string)=>void|Promise<void>;initialRequest?:ApiRequestRecord;initialDraft?:ApiRequest;initialDirty?:boolean;workspace?:boolean;
  onOpenRequest?:(item:ApiRequestRecord|null)=>void;onNewDraft?:(value:ApiRequest)=>void;onStatus?:(value:TabStatus)=>void;
  onPrepareCase?:(create:()=>Promise<string|undefined>)=>void;onDeleteRequest?:(remove:()=>Promise<void>)=>void;onController?:(value:WorkbenchController)=>void;onRun?:(scope:RunScope)=>void;epoch?:number;resources?:ApiResources|null;refreshResources?:(force?:boolean)=>Promise<ApiResources>
}){
  const [requests,setRequests]=useState<ApiRequestRecord[]>([]),[collections,setCollections]=useState<CollectionRecord[]>([])
  const [environments,setEnvironments]=useState<CollectionRecord[]>([]),[history,setHistory]=useState<ApiExecution[]>([])
  const [draft,setDraftState]=useState<ApiRequest>(()=>initialRequest?configuration(initialRequest):initialDraft??newRequest()),[selected,setSelected]=useState<ApiRequestRecord|null>(initialRequest??null)
  const latestDraft=useRef(draft)
  // Keep the synchronous draft reference in step with rendered state.
  const setDraft=(value:ApiRequest)=>{latestDraft.current=value;setDraftState(value)}
  const [folders,setFolders]=useState<FolderRecord[]>([])
  const [mode,setMode]=useState<'requests'|'environments'|'history'>('requests'),[filter,setFilter]=useState(''),[collectionId,setCollectionId]=useState('')
  const [environmentId,setEnvironmentId]=useState(''),[response,setResponse]=useState<ApiExecution|null>(null)
  const [collectionResult,setCollectionResult]=useState<CollectionResult|null>(null),[hosts,setHosts]=useState<string[]>([])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(initialDirty)
  const [config,setConfig]=useState<{kind:'collection'|'environment';record:CollectionRecord|null}|null>(null)
  const [importing,setImporting]=useState(false),[importFormat,setImportFormat]=useState('postman_collection'),[importText,setImportText]=useState('')
  const selectedRef=useRef(selected);selectedRef.current=selected
  const active=useRef<AbortController|null>(null)
  const currentHistory=useRef('')
  const actionPending=useRef(false)
  // Populate the editor with shared API records and server limits.
  const applyResources=(value:ApiResources)=>{setRequests(value.requests);setCollections(value.collections);setEnvironments(value.environments);setHistory(value.history);setHosts(value.capabilities.allowed_hosts);setFolders(value.folders)}
  // Reload API resources through the workspace cache when available.
  const refresh=async(force=true)=>{
    applyResources(await (refreshResources?refreshResources(force):loadApiResources()))
  }
  useEffect(()=>{let live=true;void (api.getOperatorToken()?Promise.resolve():authorizeApi()).then(()=>live?refresh(false):undefined).catch(cause=>{if(live)setError(String(cause))});return()=>{live=false;active.current?.abort()}},[])
  useEffect(()=>{if(resources)applyResources(resources)},[resources])
  useEffect(()=>{if(epoch)void refresh().catch(cause=>setError(String(cause)))},[epoch])
  useEffect(()=>{onStatus?.({name:draft.name,method:draft.method,sourceId:selected?.id??null,dirty,busy})},[draft.name,draft.method,selected?.id,dirty,busy,onStatus])
  // Serialize workbench actions and surface any errors to the user.
  const work=async(callback:()=>Promise<unknown>)=>{if(actionPending.current)return;actionPending.current=true;setBusy(true);setError('');setNotice('');try{await callback()}catch(cause){if(cause instanceof Error&&cause.name==='AbortError')setNotice(uiText("已停止等待，未开始的后续请求不会执行；已发送的请求可能已由服务端处理。"));else setError(cause instanceof Error?cause.message:uiText("操作失败"))}finally{actionPending.current=false;setBusy(false)}}
  // Open a saved request after guarding against discarded edits.
  const loadRequest=(item:ApiRequestRecord|null)=>{
    if(busy)return
    if(workspace&&onOpenRequest){onOpenRequest(item);return}
    if(dirty&&!window.confirm(uiText("当前请求有未保存的修改，是否放弃？")))return
    setSelected(item);setDraft(item?configuration(item):{...newRequest(),collection_id:collections.some(c=>c.id===collectionId)?collectionId:null})
    setDirty(false);setConfig(null);setMode('requests');setResponse(null);setCollectionResult(null);currentHistory.current=''
  }
  // Save the submitted draft while preserving any edits made during the save.
  const save=async(copy=false)=>{
    const submitted=latestDraft.current
    const value=copy?{...submitted,name:submitted.name.slice(0,195)+uiText(" 副本")}:submitted
    const record=await apiTesting.saveRequest(value,copy?undefined:selectedRef.current??undefined)
    selectedRef.current=record
    setSelected(record)
    const savedDraft={...configuration(record),body:submitted.body}
    const unchanged=latestDraft.current===submitted
    if(unchanged){setDraft(savedDraft);setDirty(false)}
    setNotice(unchanged?uiText("请求已保存"):uiText("提交的版本已保存，后续编辑尚未保存。"))
    try{await refresh()}
    catch{setError(uiText("请求已保存，资源列表刷新失败。"))}
    return latestDraft.current===savedDraft
  }
  // Validate the required request fields before entering the save workflow.
  const guardedSave=async(copy=false)=>{if(busy||!latestDraft.current.name.trim()||!latestDraft.current.url.trim()){setError(uiText("请填写请求名称和 URL 后保存"));return false}let saved=false;await work(async()=>{saved=await save(copy)});return saved}
  useEffect(()=>{onController?.({/* Cancel the editor's wait for the active request. */ abort:()=>active.current?.abort(),/* Save changes to the current request. */ save:()=>guardedSave(),/* Save a new request using the current draft. */ saveCopy:()=>guardedSave(true)})},[draft,selected,busy,onController])
  // Run a single request or an entire collection and display the result.
  const send=async(collection=false)=>{
    if(busy||actionPending.current)return
    setBusy(true);const controller=new AbortController();active.current=controller
    await work(async()=>{
      if(collection){const result=await apiTesting.runCollection(collectionId,environmentId||null,controller.signal);setCollectionResult(result);setResponse(result.results.find(item=>item.response)||null);setNotice(uiText("集合运行完成"))}
      else{const result=await apiTesting.execute(draft,environmentId||null,selected?.id??null,controller.signal);setResponse(result);currentHistory.current=result.id??'';setCollectionResult(null)}
      await refresh()
    });if(active.current===controller)active.current=null;setBusy(false)
  }
  const filtered=requests.filter(item=>(!collectionId||item.collection_id===collectionId)&&[item.name,item.method,item.url].join(' ').toLowerCase().includes(filter.toLowerCase()))
  // Create a test case from a snapshot of the current request.
  const promote=async()=>{
    const parameters=await apiTesting.snapshot(draft,selected?.id)
    const result=await api.createCase({title:draft.name,description:uiText("从 API 工作台创建的请求快照"),platform:'api',execution_mode:'structured',
      steps:[{order:1,intent:draft.name,driver:'api',operation:'api.request',parameters,assertions:[],always_run:false}],postconditions:[]})
    await onCaseCreated(result.id)
  }
  // Download a collection in Postman format.
  const exportCollection=async()=>{const value=await apiTesting.export({format:'postman_collection',collection_id:collectionId});downloadText(value.filename,value.content)}
  return <div className="api-workbench">
    <div className="api-page-heading"><div><h1>{uiText("API 测试")}</h1><p className="muted">{uiText("调试请求、组织集合、提取变量，并复用为自动化执行节点。")}</p></div><div className="api-toolbar"><button type="button" className="secondary-button" onClick={()=>setImporting(!importing)}>{uiText("导入")}</button>{!workspace&&<button type="button" className="secondary-button" onClick={()=>loadRequest(null)}>{uiText("新建请求")}</button>}<button type="button" className="secondary-button" onClick={()=>void work(async()=>{await authorizeApi();await refresh();setNotice(uiText("已连接本地 API 服务"))})}><RefreshCw size={14}/>{uiText("重新连接")}</button></div></div>
    {error&&<p role="alert" className="api-error">{error}</p>}{notice&&<p role="status" className="api-notice">{notice}</p>}
    {importing&&<section className="api-import"><h2>{uiText("导入请求")}</h2><select aria-label={uiText("导入格式")} value={importFormat} onChange={e=>setImportFormat(e.target.value)}><option value="postman_collection">Postman Collection v2.1</option><option value="postman_environment">{uiText("Postman 环境 JSON")}</option><option value="curl">cURL</option></select><input type="file" aria-label={uiText("导入文件")} accept=".json,.txt" onChange={e=>{const file=e.target.files?.[0];if(file){if(file.size>2097152){setError(uiText("导入文件不能超过 2 MiB"));return}void file.text().then(setImportText)}}}/><textarea aria-label={uiText("导入内容")} className="api-code mono" value={importText} onChange={e=>setImportText(e.target.value)} placeholder={uiText("粘贴 Collection、环境 JSON 或 cURL 命令")}/><div className="api-toolbar"><button type="button" className="primary-button" disabled={!importText.trim()} onClick={()=>void work(async()=>{const result=await apiTesting.import(importFormat,importText);await refresh();if(!workspace&&result.collections[0])setCollectionId(result.collections[0].id);if(result.requests[0]){if(workspace&&onOpenRequest)onOpenRequest(result.requests[0]);else{setSelected(result.requests[0]);setDraft(configuration(result.requests[0]));setDirty(false)}}setNotice(result.warnings.length?uiText("导入完成，请检查兼容性提示：")+result.warnings.join('；'):uiText("导入完成"));setImporting(false)})}>{uiText("确认导入")}</button><button type="button" className="secondary-button" onClick={()=>setImporting(false)}>{uiText("关闭")}</button></div><p className="quiet-note">{uiText("只读取请求数据，不执行 cURL shell 或 Postman JavaScript；不兼容项需要检查后才能执行。")}</p></section>}
    <div className="api-layout"><aside className="api-library">
      <div className="api-tabs" role="tablist" aria-label={uiText("API 资源")}>{[['requests',uiText("请求集合")],['environments',uiText("环境")],['history',uiText("历史")]].map(([key,label])=><button type="button" key={key} role="tab" aria-selected={mode===key} onClick={()=>{setMode(key as typeof mode);setConfig(null)}}>{label}</button>)}</div>
      <input className="api-search" aria-label={uiText("搜索 API 资源")} value={filter} onChange={e=>setFilter(e.target.value)} placeholder={uiText("搜索名称、URL 或方法")}/>
      {mode==='requests'&&<><label className="field"><span>{uiText("集合")}</span><select aria-label={uiText("筛选集合")} value={collectionId} onChange={e=>setCollectionId(e.target.value)}><option value="">{uiText("全部集合")}</option>{collections.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="api-toolbar"><button type="button" className="text-button" onClick={()=>setConfig({kind:'collection',record:null})}>{uiText("新建集合")}</button>{collectionId&&<button type="button" className="text-button" onClick={()=>setConfig({kind:'collection',record:collections.find(c=>c.id===collectionId)??null})}>{uiText("编辑集合")}</button>}</div>{workspace?<CollectionTree collections={collections} folders={folders} requests={requests} collectionId={collectionId} filter={filter} selectedId={selected?.id} onOpen={item=>loadRequest(item)} onRefresh={refresh} onRun={scope=>onRun?.(scope)}/>:<div className="api-request-list">{filtered.map(item=><button type="button" key={item.id} className={selected?.id===item.id?'active':''} onClick={()=>loadRequest(item)}><span className="api-method mono">{item.method}</span><span>{item.name}</span></button>)}{!filtered.length&&<p className="muted">{uiText("没有匹配的请求。")}</p>}</div>}</>}
      {mode==='environments'&&<><button type="button" className="text-button" onClick={()=>setConfig({kind:'environment',record:null})}>{uiText("新建环境")}</button>{environments.filter(item=>item.name.toLowerCase().includes(filter.toLowerCase())).map(item=><button type="button" className="api-resource-button" key={item.id} onClick={()=>setConfig({kind:'environment',record:item})}>{item.name}<small>v{item.version}</small></button>)}</>}
      {mode==='history'&&<div className="api-history">{history.filter(item=>[item.name,item.url,item.method,item.status].join(' ').toLowerCase().includes(filter.toLowerCase())).map(item=><button type="button" key={item.id} onClick={()=>void work(async()=>{if(item.id){setResponse(await apiTesting.historyDetail(item.id));currentHistory.current=item.id;setConfig(null)}})}><span className={`api-status-${item.status}`}>{item.status}</span><span>{item.method} · {item.name}</span><small>{new Date(item.created_at??'').toLocaleString(uiLanguage)}</small></button>)}{!history.length&&<p className="muted">{uiText("暂无请求历史。")}</p>}</div>}
    </aside><div className="api-editor-column">
      {config?<ConfigEditor key={`${config.kind}:${config.record?.id??'new'}`} initial={config.record} kind={config.kind} onCancel={()=>setConfig(null)} onSave={async value=>{const record=config.kind==='collection'?await apiTesting.saveCollection(value,config.record??undefined):await apiTesting.saveEnvironment(value,config.record??undefined);await refresh();if(config.kind==='collection')setCollectionId(record.id);else setEnvironmentId(record.id);setConfig(null);setNotice(uiText("{0}已保存", config.kind==='collection'?uiText("集合"):uiText("环境")))}} onDelete={config.record?async()=>{await apiTesting.remove(config.kind==='collection'?'collections':'environments',config.record!.id);if(config.kind==='collection')setCollectionId('');else if(environmentId===config.record!.id)setEnvironmentId('');await refresh();setConfig(null)}:undefined}/>:<>
      <div className="api-request-heading">
        <div className="api-editor-title">
          {draft.collection_id&&<span className="muted">{collections.find(item=>item.id===draft.collection_id)?.name??uiText("集合")} /</span>}
          <strong>{draft.name}{dirty?' *':''}</strong>
          <span className="muted">{selected?`v${selected.version}`:uiText("未保存")}</span>
        </div>
        <div className="api-toolbar api-execute-toolbar">
          <label className="api-environment"><span>{uiText("环境")}</span><select aria-label={uiText("执行环境")} value={environmentId} onChange={e=>setEnvironmentId(e.target.value)}><option value="">{uiText("无环境")}</option>{environments.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button type="button" className="secondary-button" disabled={busy||!collectionId} onClick={()=>{if(workspace)onRun?.({collectionId});else void send(true)}}>{uiText("运行集合")}</button>
          <button type="button" className="secondary-button" disabled={busy||!draft.name.trim()||!draft.url.trim()} onClick={()=>void work(()=>save())}>{uiText("保存请求")}</button>
        </div>
      </div>
      <RequestEditor key={workspace?undefined:selected?.id??'new'} value={draft} collections={collections} folders={workspace?folders:undefined}
        onChange={value=>{setDraft(value);setDirty(true)}}
        urlActions={busy&&active.current
          ?<button type="button" className="secondary-button api-send-button" onClick={()=>active.current?.abort()}>{uiText("取消请求")}</button>
          :<button type="button" className="primary-button api-send-button" disabled={busy||!draft.url.trim()} onClick={()=>void send()}>{uiText("发送")}</button>}/>
      <div className="api-toolbar api-save-toolbar"><div className="api-action-group"><button type="button" className="secondary-button" disabled={busy} onClick={()=>{const copy={...draft,name:draft.name+uiText(" 副本")};if(onNewDraft)onNewDraft(copy);else{setSelected(null);setDraft(copy);setDirty(true)}}}>{uiText("另存为副本")}</button></div><div className="api-action-group"><button type="button" className="secondary-button" disabled={busy||!draft.url.trim()} onClick={()=>void work(promote)}>{uiText("保存为 API 用例")}</button><button type="button" className="secondary-button" disabled={busy||!collectionId} onClick={()=>{/* Build a test case from the selected collection. */ const create=async()=>{let id:string|undefined;await work(async()=>{const draftCase=await apiTesting.collectionCase(collectionId);const created=await api.createCase(draftCase);id=created.id});return id};if(onPrepareCase)onPrepareCase(create);else void create().then(id=>{if(id)void onCaseCreated(id)})}}>{uiText("保存集合为 API 用例")}</button></div><div className="api-action-group api-export-group"><span>{uiText("导出")}</span><button type="button" className="text-button" onClick={()=>void work(async()=>{const value=await apiTesting.export({format:'curl',request:draft});downloadText(value.filename,value.content)})}><Download size={13}/>cURL</button><button type="button" className="text-button" disabled={!collectionId} onClick={()=>void work(exportCollection)}><Download size={13}/>{uiText("集合")}</button><button type="button" className="text-button" disabled={!environmentId} onClick={()=>void work(async()=>{const value=await apiTesting.export({format:'postman_environment',environment_id:environmentId});downloadText(value.filename,value.content)})}><Download size={13}/>{uiText("环境")}</button></div>{selected&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{const source=selected;/* Delete the saved request and clear the draft when it belongs to that request. */ const remove=async()=>{await apiTesting.remove('requests',source.id);if(selectedRef.current?.id===source.id){setSelected(null);setDraft(newRequest());setDirty(false)}await refresh()};if(dirty&&workspace&&onDeleteRequest){onDeleteRequest(remove);return}if(window.confirm(uiText("删除请求“{0}”？", source.name)))void work(remove)}}>{uiText("删除请求")}</button>}</div>
      <p className="quiet-note">{uiText("允许的目标主机：")}{hosts.join('、')||uiText("尚未配置；请设置 -ApiHosts 后重启后端")}{uiText("。历史最多保留 200 条，响应与上传上限 1 MiB。")}</p>
      {mode==='history'&&currentHistory.current&&<button type="button" className="secondary-button" onClick={()=>void work(async()=>{const restored=await apiTesting.historyRequest(currentHistory.current);if(workspace&&onNewDraft)onNewDraft(restored.request);else{setDraft(restored.request);setEnvironmentId('');setSelected(null);setDirty(true);setMode('requests');setNotice(uiText("已恢复历史请求配置，请核对后手动发送"))}})}>{uiText("恢复历史请求到编辑器")}</button>}
      {collectionResult&&<div className="api-collection-results"><strong>{uiText("集合结果：")}{collectionResult.status}</strong>{collectionResult.results.map((item,index)=><button type="button" className={`api-status-${item.status}`} key={item.id??index} onClick={()=>setResponse(item)}>{index+1}. {item.name} · {item.status}</button>)}</div>}
      <ResponsePanel value={response}/></>}
    </div></div>
  </div>
}
