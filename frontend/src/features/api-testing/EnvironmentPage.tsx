import {useEffect,useState} from 'react'
import ConfigEditor from './ConfigEditor'
import {apiTesting,downloadText} from './client'
import {configuration} from './types'
import type {Collection,CollectionRecord} from './types'

export default function EnvironmentPage({onChange,active=true}:{onChange:()=>void;active?:boolean}){
  const [items,setItems]=useState<CollectionRecord[]>([]),[search,setSearch]=useState(''),[error,setError]=useState('')
  const [editing,setEditing]=useState<{record:CollectionRecord|null;value?:Collection;key:string}|null>(null)
  const refresh=async()=>setItems(await apiTesting.environments())
  useEffect(()=>{if(!active)return;void refresh().catch(cause=>setError(String(cause)))},[active])
  const action=async(callback:()=>Promise<void>)=>{setError('');try{await callback()}catch(cause){setError(String(cause))}}
  return <section className="api-page"><header className="api-page-heading"><div><h2>环境管理</h2><p className="muted">集中维护变量。运行时冻结环境，提取值不会覆盖保存内容。</p></div><button type="button" className="primary-button" onClick={()=>setEditing({record:null,key:crypto.randomUUID()})}>新建环境</button></header>
    {error&&<p role="alert" className="api-error">{error}</p>}<input aria-label="搜索环境" placeholder="搜索环境名称" value={search} onChange={event=>setSearch(event.target.value)}/>
    <div className="api-management-layout"><aside>{items.filter(item=>item.name.toLowerCase().includes(search.toLowerCase())).map(item=><article className="api-resource-card" key={item.id}><button type="button" className="api-resource-button" onClick={()=>setEditing({record:item,key:item.id+':'+item.version})}>{item.name}<small>v{item.version}</small></button><div className="api-toolbar"><button type="button" className="text-button" onClick={()=>setEditing({record:null,value:{...configuration(item),name:item.name+' 副本'},key:crypto.randomUUID()})}>复制环境</button><button type="button" className="text-button" onClick={()=>void action(async()=>{const value=await apiTesting.export({format:'postman_environment',environment_id:item.id});downloadText(value.filename,value.content)})}>导出环境</button></div></article>)}</aside>
    <div>{editing?<ConfigEditor key={editing.key} initial={editing.record} initialValue={editing.value} kind="环境" onCancel={()=>setEditing(null)} onSave={async value=>{await apiTesting.saveEnvironment(value,editing.record??undefined);await refresh();onChange();setEditing(null)}} onDelete={editing.record?async()=>{await apiTesting.remove('environments',editing.record!.id);await refresh();onChange();setEditing(null)}:undefined}/>:<p className="quiet-note">选择环境进行编辑，或新建一个环境。</p>}</div></div>
  </section>
}
