import { uiText } from '../../shared/i18n.ts'
import {useState} from 'react'
import type {Collection,CollectionRecord} from './types'
import {configuration} from './types'
import {VariablesEditor} from './Fields'

// Edit the description and shared variables of a collection or environment.
export default function ConfigEditor({initial,initialValue,kind,onSave,onDelete,onCancel}:{initial:CollectionRecord|null;initialValue?:Collection;kind:'collection'|'environment';onSave:(value:Collection)=>Promise<void>;onDelete?:()=>Promise<void>;onCancel:()=>void}){
  const [draft,setDraft]=useState<Collection>(initial?configuration(initial):initialValue??{name:'',description:'',variables:[]})
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  // Manage pending state and display failures while saving editor changes.
  const act=async(callback:()=>Promise<void>)=>{setBusy(true);setError('');try{await callback()}catch(cause){setError(cause instanceof Error?cause.message:uiText("保存失败"))}finally{setBusy(false)}}
  const collection=kind==='collection'
  const heading=collection
    ? initial?uiText('编辑集合'):uiText('新建集合')
    : initial?uiText('编辑环境'):uiText('新建环境')
  return <section className="api-config-editor"><h2>{heading}</h2>
    <label className="field"><span>{collection?uiText('集合名称'):uiText('环境名称')}</span><input value={draft.name} maxLength={200} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
    <label className="field"><span>{uiText("描述")}</span><textarea value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label>
    <VariablesEditor value={draft.variables} onChange={variables=>setDraft({...draft,variables})}/>
    {error&&<p role="alert" className="api-error">{error}</p>}
    <div className="api-toolbar"><button type="button" className="primary-button" disabled={busy||!draft.name.trim()} onClick={()=>void act(()=>onSave(draft))}>{collection?uiText('保存集合'):uiText('保存环境')}</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{uiText("关闭")}</button>{onDelete&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{if(window.confirm(collection?uiText('删除集合“{0}”？', initial?.name):uiText('删除环境“{0}”？', initial?.name)))void act(onDelete)}}>{collection?uiText('删除集合'):uiText('删除环境')}</button>}</div>
  </section>
}
