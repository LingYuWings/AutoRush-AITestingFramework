import {useState} from 'react'
import type {Collection,CollectionRecord} from './types'
import {configuration} from './types'
import {VariablesEditor} from './Fields'

export default function ConfigEditor({initial,kind,onSave,onDelete,onCancel}:{initial:CollectionRecord|null;kind:'集合'|'环境';onSave:(value:Collection)=>Promise<void>;onDelete?:()=>Promise<void>;onCancel:()=>void}){
  const [draft,setDraft]=useState<Collection>(initial?configuration(initial):{name:'',description:'',variables:[]})
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const act=async(callback:()=>Promise<void>)=>{setBusy(true);setError('');try{await callback()}catch(cause){setError(cause instanceof Error?cause.message:'保存失败')}finally{setBusy(false)}}
  return <section className="api-config-editor"><h2>{initial?'编辑':'新建'}{kind}</h2>
    <label className="field"><span>{kind}名称</span><input value={draft.name} maxLength={200} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
    <label className="field"><span>描述</span><textarea value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label>
    <VariablesEditor value={draft.variables} onChange={variables=>setDraft({...draft,variables})}/>
    {error&&<p role="alert" className="api-error">{error}</p>}
    <div className="api-toolbar"><button type="button" className="primary-button" disabled={busy||!draft.name.trim()} onClick={()=>void act(()=>onSave(draft))}>保存{kind}</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>关闭</button>{onDelete&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{if(window.confirm(`删除${kind}“${initial?.name}”？`))void act(onDelete)}}>删除{kind}</button>}</div>
  </section>
}
