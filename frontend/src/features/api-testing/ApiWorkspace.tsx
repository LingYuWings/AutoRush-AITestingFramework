import { uiText } from '../../shared/i18n.ts'
import {useCallback,useEffect,useRef,useState} from 'react'
import {X} from '../../components/icons'
import ApiWorkbench from './ApiWorkbench'
import type {TabStatus,WorkbenchController} from './ApiWorkbench'
import type {ApiRequest,ApiRequestRecord} from './types'
import EnvironmentPage from './EnvironmentPage'
import HistoryPage from './HistoryPage'
import RunnerPage,{presetFromRun} from './RunnerPage'
import type {RunnerPreset} from './RunnerPage'
import type {ApiRun} from './runner-client'
import {loadApiResources,type ApiResources} from './resources'
import {PageHeader} from '../../components/ui'
import './api-testing.css'

export type ApiNavigationGuard=((proceed:()=>void)=>void)|null
type Tab={key:string;request?:ApiRequestRecord;draft?:ApiRequest;initialDirty?:boolean;meta:TabStatus}
// Allocate a tab with a fresh key and untouched draft metadata.
const blank=():Tab=>({key:crypto.randomUUID(),meta:{name:uiText("未命名请求"),sourceId:null,dirty:false,busy:false}})
export const apiSections=[['workbench',uiText("请求工作台")],['runner',uiText("集合 Runner")],['environments',uiText("环境管理")],['history',uiText("执行历史")]] as const
const sections=apiSections

// Keep request tabs and shared resources available across API workspace sections.
export default function ApiWorkspace({section,onNavigate,onCaseCreated,onGuardChange}:{section?:string;onNavigate:(section:string)=>void;onCaseCreated:(id:string)=>void|Promise<void>;onGuardChange:(guard:ApiNavigationGuard)=>void}){
  const [tabs,setTabs]=useState<Tab[]>(()=>[blank()]),[active,setActive]=useState(''),[epoch,setEpoch]=useState(0),[preset,setPreset]=useState<RunnerPreset|null>(null)
  const [pending,setPending]=useState<{keys:string[];proceed:()=>void|Promise<void>;saveAsCopy?:boolean}|null>(null),[error,setError]=useState(''),[saving,setSaving]=useState(false)
  const controllers=useRef(new Map<string,WorkbenchController>())
  const resourceCache=useRef<ApiResources|null>(null),resourceFlight=useRef<Promise<ApiResources>|null>(null)
  const [resources,setResources]=useState<ApiResources|null>(null)
  // Share in-flight resource loads and optionally reuse the cached result.
  const refreshResources=useCallback((force=true):Promise<ApiResources>=>{
    if(!force&&resourceCache.current)return Promise.resolve(resourceCache.current)
    if(resourceFlight.current)return resourceFlight.current
    resourceFlight.current=loadApiResources().then(value=>{resourceCache.current=value;setResources(value);return value}).finally(()=>{resourceFlight.current=null})
    return resourceFlight.current
  },[])
  const callbacks=useRef(new Map<string,{status:(value:TabStatus)=>void;controller:(value:WorkbenchController)=>void}>())
  const page=sections.some(([key])=>key===section)?section!:'workbench'
  const activeKey=tabs.some(tab=>tab.key===active)?active:tabs[0]?.key
  const dirty=tabs.filter(tab=>tab.meta.dirty)
  // Ask how to handle unsaved tabs before running a navigation or close action.
  const guard=useCallback((proceed:()=>void,keys?:string[])=>{const list=keys??tabs.filter(tab=>tab.meta.dirty).map(tab=>tab.key);if(list.length)setPending({keys:list,proceed});else proceed()},[tabs])
  useEffect(()=>{onGuardChange(dirty.length?proceed=>guard(proceed):null);return()=>onGuardChange(null)},[dirty.length,guard,onGuardChange])
  useEffect(()=>{/* Let the browser warn before closing the page with unsaved tabs. */ const unload=(event:BeforeUnloadEvent)=>{if(dirty.length){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload)},[dirty.length])
  // Create stable callbacks that connect a request editor to its workspace tab.
  const bindings=(key:string)=>{if(!callbacks.current.has(key))callbacks.current.set(key,{
    // Update the tab only when the editor's metadata changes.
    status:value=>setTabs(current=>{const old=current.find(tab=>tab.key===key);if(!old||JSON.stringify(old.meta)===JSON.stringify(value))return current;return current.map(tab=>tab.key===key?{...tab,meta:value}:tab)}),
    // Store the editor controls used to save or cancel work in this tab.
    controller:value=>{controllers.current.set(key,value)}
  });return callbacks.current.get(key)!}
  // Reuse the tab for an open request or create a new tab for it.
  const open=(request:ApiRequestRecord|null,draft?:ApiRequest)=>{
    const existing=request?tabs.find(tab=>tab.meta.sourceId===request.id):null
    if(existing){setActive(existing.key);onNavigate('workbench');return}
    if(tabs.length>=20){setError(uiText("最多打开 20 个请求标签，请先保存并关闭一些标签。"));return}
    const tab:Tab=request?{key:crypto.randomUUID(),request,meta:{name:request.name,sourceId:request.id,dirty:false,busy:false}}:draft?{key:crypto.randomUUID(),draft,initialDirty:true,meta:{name:draft.name,sourceId:null,dirty:true,busy:false}}:blank()
    setTabs(current=>[...current,tab]);setActive(tab.key);onNavigate('workbench')
  }
  // Resolve unsaved edits before disposing of a tab and its active request.
  const close=(tab:Tab)=>guard(()=>{
    controllers.current.get(tab.key)?.abort();controllers.current.delete(tab.key);callbacks.current.delete(tab.key)
    setTabs(current=>{const remaining=current.filter(item=>item.key!==tab.key);return remaining.length?remaining:[blank()]});if(activeKey===tab.key)setActive('')
  },tab.meta.dirty?[tab.key]:[])
  // Open the runner with parameters from an earlier run.
  const latest=(run:ApiRun)=>{setPreset(presetFromRun(run));onNavigate('runner')}
  // Resolve the pending action by saving selected tabs or discarding their edits.
  const choose=async(save:boolean)=>{if(!pending)return;setSaving(true);setError('');try{
    if(save)for(const key of pending.keys){const controller=controllers.current.get(key);if(!await (pending.saveAsCopy?controller?.saveCopy():controller?.save())){setError(uiText("保存未完成，请取消对话框并检查请求名称、URL 或版本提示。"));return}}
    await pending.proceed();setPending(null)
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause))}finally{setSaving(false)}}
  return <div className="api-workspace"><PageHeader title={uiText("API 测试")} description={uiText("调试请求、组织集合与环境，批量运行并复用为自动化用例节点。")}/><nav className="section-nav" aria-label={uiText("API 模块导航")}>{sections.map(([key,label])=><a key={key} href={`#/api-testing/${key}`} aria-current={page===key?'page':undefined} onClick={event=>{event.preventDefault();onNavigate(key)}}>{label}</a>)}</nav>
    {error&&!pending&&<p role="alert" className="api-error">{error}</p>}
    <div className="api-section" hidden={page!=='workbench'}><div className="api-request-tabs" role="tablist" aria-label={uiText("请求标签")}>{tabs.map(tab=><div key={tab.key} className={tab.key===activeKey?'active':''}><button type="button" role="tab" aria-selected={tab.key===activeKey} onClick={()=>setActive(tab.key)}>{tab.meta.name}{tab.meta.dirty&&<span className="api-tab-dirty" aria-label={uiText("未保存")} title={uiText("未保存")}/>}{tab.meta.busy&&<span className="api-tab-busy">{uiText(" · 处理中")}</span>}</button><button type="button" className="api-tab-close" aria-label={uiText("关闭请求 {0}", tab.meta.name)} title={uiText("关闭标签")} onClick={()=>close(tab)}><X size={13}/></button></div>)}</div>
      {tabs.map(tab=><div key={tab.key} className="api-tab-panel" hidden={tab.key!==activeKey}><ApiWorkbench workspace resources={resources} refreshResources={refreshResources} initialRequest={tab.request} initialDraft={tab.draft} initialDirty={tab.initialDirty} onStatus={bindings(tab.key).status} onController={bindings(tab.key).controller} epoch={epoch}
        onPrepareCase={create=>guard(()=>{void create().then(id=>{if(id)void onCaseCreated(id)})})} onDeleteRequest={remove=>setPending({keys:[tab.key],proceed:remove,saveAsCopy:true})} onOpenRequest={request=>open(request)} onNewDraft={draft=>open(null,draft)} onRun={scope=>{setPreset(scope);onNavigate('runner')}} onCaseCreated={id=>guard(()=>{void onCaseCreated(id)})}/></div>)}
    </div>
    <div className="api-section" hidden={page!=='runner'}><RunnerPage refreshResources={refreshResources} active={page==='runner'} preset={preset} onLatest={latest}/></div>
    <div className="api-section" hidden={page!=='environments'}><EnvironmentPage active={page==='environments'} onChange={()=>setEpoch(current=>current+1)}/></div>
    <div className="api-section" hidden={page!=='history'}><HistoryPage active={page==='history'} onRestore={draft=>open(null,draft)} onLatest={latest}/></div>
    {pending&&<div className="api-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!saving){setPending(null);setError('')}}}><section className="api-draft-dialog" role="dialog" aria-modal="true" aria-label={uiText("未保存的请求")} onKeyDown={event=>{if(event.key==='Escape'&&!saving){event.preventDefault();setPending(null);setError('')}}}><h2>{uiText("保留未保存的更改")}</h2><p>{pending.saveAsCopy?uiText("删除原请求前，可将当前修改保留为新请求。放弃并删除会丢弃本次编辑。"):uiText("有 {0} 个请求尚未保存。保存后继续，或放弃本次编辑。", pending.keys.length)}</p>{error&&<p role="alert" className="api-error">{error}</p>}<div className="api-toolbar api-dialog-actions"><button type="button" className="primary-button" autoFocus disabled={saving} onClick={()=>void choose(true)}>{pending.saveAsCopy?uiText("保留为新请求"):uiText("保存更改")}</button><button type="button" className="secondary-button" disabled={saving} onClick={()=>void choose(false)}>{pending.saveAsCopy?uiText("放弃并删除"):uiText("放弃更改")}</button><button type="button" className="text-button" disabled={saving} onClick={()=>{setPending(null);setError('')}}>{uiText("取消")}</button></div></section></div>}
  </div>
}
