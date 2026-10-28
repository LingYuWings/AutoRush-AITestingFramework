import {useEffect,useRef,useState} from 'react'
import {api} from '../../shared/api'
import {apiTesting,authorizeApi,downloadText} from './client'
import type {ApiExecution,ApiRequest,ApiRequestRecord,CollectionRecord,CollectionResult} from './types'
import {configuration,newRequest} from './types'
import RequestEditor from './RequestEditor'
import ResponsePanel from './ResponsePanel'
import ConfigEditor from './ConfigEditor'
import './api-testing.css'

export default function ApiWorkbench({onCaseCreated}:{onCaseCreated:(id:string)=>void|Promise<void>}){
  const [requests,setRequests]=useState<ApiRequestRecord[]>([]),[collections,setCollections]=useState<CollectionRecord[]>([])
  const [environments,setEnvironments]=useState<CollectionRecord[]>([]),[history,setHistory]=useState<ApiExecution[]>([])
  const [draft,setDraft]=useState<ApiRequest>(newRequest),[selected,setSelected]=useState<ApiRequestRecord|null>(null)
  const [mode,setMode]=useState<'requests'|'environments'|'history'>('requests'),[filter,setFilter]=useState(''),[collectionId,setCollectionId]=useState('')
  const [environmentId,setEnvironmentId]=useState(''),[response,setResponse]=useState<ApiExecution|null>(null)
  const [collectionResult,setCollectionResult]=useState<CollectionResult|null>(null),[hosts,setHosts]=useState<string[]>([])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(false)
  const [config,setConfig]=useState<{kind:'集合'|'环境';record:CollectionRecord|null}|null>(null)
  const [importing,setImporting]=useState(false),[importFormat,setImportFormat]=useState('postman_collection'),[importText,setImportText]=useState('')
  const active=useRef<AbortController|null>(null)
  const currentHistory=useRef('')
  const actionPending=useRef(false)
  const refresh=async()=>{
    const [r,c,e,h,capabilities]=await Promise.all([apiTesting.requests(),apiTesting.collections(),apiTesting.environments(),apiTesting.history(),apiTesting.capabilities()])
    setRequests(r);setCollections(c);setEnvironments(e);setHistory(h);setHosts(capabilities.allowed_hosts)
  }
  useEffect(()=>{let live=true;void authorizeApi().then(()=>live?refresh():undefined).catch(cause=>{if(live)setError(String(cause))});return()=>{live=false;active.current?.abort()}},[])
  const work=async(callback:()=>Promise<void>)=>{if(actionPending.current)return;actionPending.current=true;setBusy(true);setError('');setNotice('');try{await callback()}catch(cause){if(cause instanceof Error&&cause.name==='AbortError')setNotice('已停止等待，未开始的后续请求不会执行；已发送的请求可能已由服务端处理。');else setError(cause instanceof Error?cause.message:'操作失败')}finally{actionPending.current=false;setBusy(false)}}
  const loadRequest=(item:ApiRequestRecord|null)=>{
    if(busy)return
    if(dirty&&!window.confirm('当前请求有未保存的修改，是否放弃？'))return
    setSelected(item);setDraft(item?configuration(item):{...newRequest(),collection_id:collections.some(c=>c.id===collectionId)?collectionId:null})
    setDirty(false);setConfig(null);setMode('requests');setResponse(null);setCollectionResult(null);currentHistory.current=''
  }
  const save=async()=>{
    const record=await apiTesting.saveRequest(draft,selected??undefined)
    setSelected(record);setDraft(configuration(record));setDirty(false);setNotice('请求已保存');await refresh()
  }
  const send=async(collection=false)=>{
    if(busy||actionPending.current)return
    setBusy(true);const controller=new AbortController();active.current=controller
    await work(async()=>{
      if(collection){const result=await apiTesting.runCollection(collectionId,environmentId||null,controller.signal);setCollectionResult(result);setResponse(result.results.find(item=>item.response)||null);setNotice('集合运行完成')}
      else{const result=await apiTesting.execute(draft,environmentId||null,selected?.id??null,controller.signal);setResponse(result);currentHistory.current=result.id??'';setCollectionResult(null)}
      await refresh()
    });if(active.current===controller)active.current=null;setBusy(false)
  }
  const filtered=requests.filter(item=>(!collectionId||item.collection_id===collectionId)&&[item.name,item.method,item.url].join(' ').toLowerCase().includes(filter.toLowerCase()))
  const promote=async()=>{
    const parameters=await apiTesting.snapshot(draft,selected?.id)
    const result=await api.createCase({title:draft.name,description:'从 API 工作台创建的请求快照',platform:'api',execution_mode:'structured',
      steps:[{order:1,intent:draft.name,driver:'api',operation:'api.request',parameters,assertions:[],always_run:false}],postconditions:[]})
    await onCaseCreated(result.id)
  }
  const exportCollection=async()=>{const value=await apiTesting.export({format:'postman_collection',collection_id:collectionId});downloadText(value.filename,value.content)}
  return <div className="api-workbench">
    <div className="api-page-heading"><div><h1>API 测试</h1><p className="muted">调试请求、组织集合、提取变量，并复用为自动化执行节点。</p></div><div className="api-toolbar"><button type="button" className="secondary-button" onClick={()=>setImporting(!importing)}>导入</button><button type="button" className="secondary-button" onClick={()=>loadRequest(null)}>新建请求</button><button type="button" className="text-button" onClick={()=>void work(async()=>{await authorizeApi();await refresh();setNotice('已连接本地 API 服务')})}>重新连接</button></div></div>
    {error&&<p role="alert" className="api-error">{error}</p>}{notice&&<p role="status" className="api-notice">{notice}</p>}
    {importing&&<section className="api-import"><h2>导入请求</h2><select aria-label="导入格式" value={importFormat} onChange={e=>setImportFormat(e.target.value)}><option value="postman_collection">Postman Collection v2.1</option><option value="postman_environment">Postman 环境 JSON</option><option value="curl">cURL</option></select><input type="file" aria-label="导入文件" accept=".json,.txt" onChange={e=>{const file=e.target.files?.[0];if(file){if(file.size>2097152){setError('导入文件不能超过 2 MiB');return}void file.text().then(setImportText)}}}/><textarea aria-label="导入内容" className="api-code mono" value={importText} onChange={e=>setImportText(e.target.value)} placeholder="粘贴 Collection、环境 JSON 或 cURL 命令"/><div className="api-toolbar"><button type="button" className="primary-button" disabled={!importText.trim()} onClick={()=>void work(async()=>{const result=await apiTesting.import(importFormat,importText);await refresh();if(result.collections[0])setCollectionId(result.collections[0].id);if(result.requests[0]){setSelected(result.requests[0]);setDraft(configuration(result.requests[0]));setDirty(false)}setNotice(result.warnings.length?'导入完成，请检查兼容性提示：'+result.warnings.join('；'):'导入完成');setImporting(false)})}>确认导入</button><button type="button" className="secondary-button" onClick={()=>setImporting(false)}>关闭</button></div><p className="quiet-note">只读取请求数据，不执行 cURL shell 或 Postman JavaScript；不兼容项需要检查后才能执行。</p></section>}
    <div className="api-layout"><aside className="api-library">
      <div className="api-tabs" role="tablist" aria-label="API 资源">{[['requests','请求集合'],['environments','环境'],['history','历史']].map(([key,label])=><button type="button" key={key} role="tab" aria-selected={mode===key} onClick={()=>{setMode(key as typeof mode);setConfig(null)}}>{label}</button>)}</div>
      <input className="api-search" aria-label="搜索 API 资源" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="搜索名称、URL 或方法"/>
      {mode==='requests'&&<><label className="field"><span>集合</span><select aria-label="筛选集合" value={collectionId} onChange={e=>setCollectionId(e.target.value)}><option value="">全部集合</option>{collections.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="api-toolbar"><button type="button" className="text-button" onClick={()=>setConfig({kind:'集合',record:null})}>新建集合</button>{collectionId&&<button type="button" className="text-button" onClick={()=>setConfig({kind:'集合',record:collections.find(c=>c.id===collectionId)??null})}>编辑集合</button>}</div><div className="api-request-list">{filtered.map(item=><button type="button" key={item.id} className={selected?.id===item.id?'active':''} onClick={()=>loadRequest(item)}><span className="api-method mono">{item.method}</span><span>{item.name}</span></button>)}{!filtered.length&&<p className="muted">没有匹配的请求。</p>}</div></>}
      {mode==='environments'&&<><button type="button" className="text-button" onClick={()=>setConfig({kind:'环境',record:null})}>新建环境</button>{environments.filter(item=>item.name.toLowerCase().includes(filter.toLowerCase())).map(item=><button type="button" className="api-resource-button" key={item.id} onClick={()=>setConfig({kind:'环境',record:item})}>{item.name}<small>v{item.version}</small></button>)}</>}
      {mode==='history'&&<div className="api-history">{history.filter(item=>[item.name,item.url,item.method,item.status].join(' ').toLowerCase().includes(filter.toLowerCase())).map(item=><button type="button" key={item.id} onClick={()=>void work(async()=>{if(item.id){setResponse(await apiTesting.historyDetail(item.id));currentHistory.current=item.id;setConfig(null)}})}><span className={`api-status-${item.status}`}>{item.status}</span><span>{item.method} · {item.name}</span><small>{new Date(item.created_at??'').toLocaleString()}</small></button>)}{!history.length&&<p className="muted">暂无请求历史。</p>}</div>}
    </aside><div className="api-editor-column">
      {config?<ConfigEditor key={`${config.kind}:${config.record?.id??'new'}`} initial={config.record} kind={config.kind} onCancel={()=>setConfig(null)} onSave={async value=>{const record=config.kind==='集合'?await apiTesting.saveCollection(value,config.record??undefined):await apiTesting.saveEnvironment(value,config.record??undefined);await refresh();if(config.kind==='集合')setCollectionId(record.id);else setEnvironmentId(record.id);setConfig(null);setNotice(`${config.kind}已保存`)}} onDelete={config.record?async()=>{await apiTesting.remove(config.kind==='集合'?'collections':'environments',config.record!.id);if(config.kind==='集合')setCollectionId('');else if(environmentId===config.record!.id)setEnvironmentId('');await refresh();setConfig(null)}:undefined}/>:<>
      <div className="api-toolbar api-execute-toolbar"><label className="api-environment"><span>环境</span><select aria-label="执行环境" value={environmentId} onChange={e=>setEnvironmentId(e.target.value)}><option value="">无环境</option>{environments.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="primary-button" disabled={busy||!draft.url.trim()} onClick={()=>void send()}>发送</button><button type="button" className="secondary-button" disabled={busy||!collectionId} onClick={()=>void send(true)}>运行集合</button>{busy&&<button type="button" className="secondary-button" onClick={()=>active.current?.abort()}>取消请求</button>}</div>
      <div className="api-editor-title"><strong>{draft.name}{dirty?' *':''}</strong><span className="muted">{selected?`v${selected.version}`:'未保存'}</span></div>
      <RequestEditor key={selected?.id??'new'} value={draft} collections={collections} onChange={value=>{setDraft(value);setDirty(true)}}/>
      <div className="api-toolbar api-save-toolbar"><button type="button" className="primary-button" disabled={busy||!draft.name.trim()||!draft.url.trim()} onClick={()=>void work(save)}>保存请求</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setSelected(null);setDraft({...draft,name:draft.name+' 副本'});setDirty(true)}}>另存为副本</button><button type="button" className="secondary-button" disabled={busy||!draft.url.trim()} onClick={()=>void work(promote)}>保存为 API 用例</button><button type="button" className="text-button" onClick={()=>void work(async()=>{const value=await apiTesting.export({format:'curl',request:draft});downloadText(value.filename,value.content)})}>导出 cURL</button><button type="button" className="text-button" disabled={!collectionId} onClick={()=>void work(exportCollection)}>导出集合</button><button type="button" className="text-button" disabled={!environmentId} onClick={()=>void work(async()=>{const value=await apiTesting.export({format:'postman_environment',environment_id:environmentId});downloadText(value.filename,value.content)})}>导出环境</button>{selected&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{if(window.confirm(`删除请求“${selected.name}”？`))void work(async()=>{await apiTesting.remove('requests',selected.id);setSelected(null);setDraft(newRequest());setDirty(false);await refresh()})}}>删除请求</button>}</div>
      <p className="quiet-note">允许的目标主机：{hosts.join('、')||'尚未配置；请设置 -ApiHosts 后重启后端'}。历史最多保留 200 条，响应与上传上限 1 MiB。</p>
      {mode==='history'&&currentHistory.current&&<button type="button" className="secondary-button" onClick={()=>void work(async()=>{const restored=await apiTesting.historyRequest(currentHistory.current);setDraft(restored.request);setEnvironmentId('');setSelected(null);setDirty(true);setMode('requests');setNotice('已恢复历史请求配置，请核对后手动发送')})}>恢复历史请求到编辑器</button>}
      {collectionResult&&<div className="api-collection-results"><strong>集合结果：{collectionResult.status}</strong>{collectionResult.results.map((item,index)=><button type="button" className={`api-status-${item.status}`} key={item.id??index} onClick={()=>setResponse(item)}>{index+1}. {item.name} · {item.status}</button>)}</div>}
      <ResponsePanel value={response}/></>}
    </div></div>
  </div>
}
