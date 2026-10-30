import {folderPath} from './types'
import {useState} from 'react'
import {apiTesting} from './client'
import {configuration} from './types'
import type {ApiRequestRecord,CollectionRecord,Folder,FolderRecord} from './types'

export type RunScope={collectionId:string;folderId?:string}
type Entry={kind:'folders';record:FolderRecord}|{kind:'requests';record:ApiRequestRecord}
export default function CollectionTree({collections,folders,requests,collectionId,filter,selectedId,onOpen,onRefresh,onRun}:{
  collections:CollectionRecord[];folders:FolderRecord[];requests:ApiRequestRecord[];collectionId:string;filter:string;selectedId?:string;
  onOpen:(record:ApiRequestRecord)=>void;onRefresh:()=>Promise<void>;onRun:(scope:RunScope)=>void
}){
  const [editing,setEditing]=useState<{record:FolderRecord|null;collectionId:string;parentId:string|null}|null>(null)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  const act=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();await onRefresh()}catch(cause){setError(cause instanceof Error?cause.message:String(cause))}finally{setBusy(false)}}
  const entries=(cid:string|null,parent:string|null):Entry[]=>[
    ...folders.filter(item=>item.collection_id===cid&&item.parent_id===parent).map(record=>({kind:'folders' as const,record})),
    ...requests.filter(item=>item.collection_id===cid&&(item.folder_id??null)===parent).map(record=>({kind:'requests' as const,record}))
  ].sort((a,b)=>(a.record.position??0)-(b.record.position??0)||a.record.created_at.localeCompare(b.record.created_at))
  const matches=(entry:Entry):boolean=>[entry.record.name,entry.kind==='requests'?entry.record.url:'',entry.kind==='requests'?entry.record.method:''].join(' ').toLowerCase().includes(filter.toLowerCase())||entry.kind==='folders'&&entries(entry.record.collection_id,entry.record.id).some(matches)
  const move=(items:Entry[],index:number,delta:number,cid:string,parent:string|null)=>void act(async()=>{
    const sorted=[...items];[sorted[index],sorted[index+delta]]=[sorted[index+delta],sorted[index]]
    await apiTesting.reorder({collection_id:cid,parent_id:parent,items:sorted.map(item=>({kind:item.kind,id:item.record.id,version:item.record.version}))})
  })
  function branch(cid:string|null,parent:string|null){
    const items=entries(cid,parent)
    return <ul className="api-tree-list">{items.filter(matches).map(entry=>{
      const index=items.indexOf(entry),record=entry.record
      const order=cid&&<span className="api-tree-order"><button type="button" aria-label={`${record.name} 上移`} title="调整保存顺序" disabled={busy||index===0} onClick={()=>move(items,index,-1,cid,parent)}>↑</button><button type="button" aria-label={`${record.name} 下移`} disabled={busy||index===items.length-1} onClick={()=>move(items,index,1,cid,parent)}>↓</button></span>
      return <li key={record.id}>{entry.kind==='folders'?<details open><summary><span>{record.name}</span>{order}</summary><div className="api-tree-actions"><button type="button" disabled={busy} onClick={()=>setEditing({record:entry.record,collectionId:entry.record.collection_id,parentId:entry.record.parent_id})}>编辑</button><button type="button" disabled={busy} onClick={()=>setEditing({record:null,collectionId:entry.record.collection_id,parentId:record.id})}>添加子文件夹</button><button type="button" onClick={()=>onRun({collectionId:entry.record.collection_id,folderId:record.id})}>运行文件夹</button></div>{branch(entry.record.collection_id,record.id)}</details>:<div className="api-tree-request"><button type="button" className={selectedId===record.id?'active':''} onClick={()=>onOpen(entry.record)}><span className="api-method">{entry.record.method}</span>{record.name}</button>{order}</div>}</li>
    })}</ul>
  }
  return <section aria-label="集合请求树" className="api-tree">
    {error&&<p role="alert" className="api-error">{error}</p>}
    {collectionId&&<button type="button" className="text-button" onClick={()=>setEditing({record:null,collectionId,parentId:null})}>新建文件夹</button>}
    {collections.filter(item=>!collectionId||item.id===collectionId).map(collection=><details key={collection.id} open><summary><strong>{collection.name}</strong></summary><div className="api-tree-actions"><button type="button" onClick={()=>setEditing({record:null,collectionId:collection.id,parentId:null})}>添加文件夹</button><button type="button" onClick={()=>onRun({collectionId:collection.id})}>运行集合</button></div>{branch(collection.id,null)}</details>)}
    {!collectionId&&requests.some(item=>!item.collection_id)&&<details open><summary>未分组</summary>{branch(null,null)}</details>}
    {!requests.some(item=>(!collectionId||item.collection_id===collectionId)&&[item.name,item.url,item.method].join(' ').toLowerCase().includes(filter.toLowerCase()))&&<p className="muted">没有匹配的请求。</p>}
    {editing&&<FolderEditor key={editing.record?.id??`${editing.collectionId}:${editing.parentId}`} folders={folders} initial={editing.record} collectionId={editing.collectionId} parentId={editing.parentId} busy={busy}
      onCancel={()=>setEditing(null)} onSave={value=>act(async()=>{await apiTesting.saveFolder(value,editing.record??undefined);setEditing(null)})}
      onDelete={editing.record?()=>act(async()=>{await apiTesting.remove('folders',editing.record!.id);setEditing(null)}):undefined}/>}
  </section>
}

function FolderEditor({initial,collectionId,parentId,folders,busy,onSave,onCancel,onDelete}:{initial:FolderRecord|null;collectionId:string;parentId:string|null;folders:FolderRecord[];busy:boolean;onSave:(value:Folder)=>Promise<void>;onCancel:()=>void;onDelete?:()=>Promise<void>}){
  const [draft,setDraft]=useState<Folder>(initial?configuration(initial):{name:'',collection_id:collectionId,parent_id:parentId,description:'',position:0})
  return <section className="api-folder-editor" aria-label="文件夹编辑"><h3>{initial?'编辑':'新建'}文件夹</h3><label className="field"><span>文件夹名称</span><input value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label><label className="field"><span>父文件夹</span><select value={draft.parent_id??''} onChange={event=>setDraft({...draft,parent_id:event.target.value||null})}><option value="">集合根目录</option>{folders.filter(item=>item.collection_id===collectionId&&item.id!==initial?.id).map(item=><option key={item.id} value={item.id}>{folderPath(item,folders)} · {item.id.slice(0,6)}</option>)}</select></label><label className="field"><span>文件夹描述</span><textarea value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label><div className="api-toolbar"><button type="button" className="primary-button" disabled={busy||!draft.name.trim()} onClick={()=>void onSave(draft)}>保存文件夹</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>关闭</button>{onDelete&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{if(window.confirm('删除此空文件夹？'))void onDelete()}}>删除文件夹</button>}</div></section>
}
