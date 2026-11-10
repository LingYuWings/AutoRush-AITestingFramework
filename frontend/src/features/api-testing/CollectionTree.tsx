import { uiText } from '../../shared/i18n.ts'
import {folderPath} from './types'
import {useState} from 'react'
import {apiTesting} from './client'
import {configuration} from './types'
import type {ApiRequestRecord,CollectionRecord,Folder,FolderRecord} from './types'

export type RunScope={collectionId:string;folderId?:string}
type Entry={kind:'folders';record:FolderRecord}|{kind:'requests';record:ApiRequestRecord}
// Browse and manage saved requests and nested folders by collection.
export default function CollectionTree({collections,folders,requests,collectionId,filter,selectedId,onOpen,onRefresh,onRun}:{
  collections:CollectionRecord[];folders:FolderRecord[];requests:ApiRequestRecord[];collectionId:string;filter:string;selectedId?:string;
  onOpen:(record:ApiRequestRecord)=>void;onRefresh:()=>Promise<void>;onRun:(scope:RunScope)=>void
}){
  const [editing,setEditing]=useState<{record:FolderRecord|null;collectionId:string;parentId:string|null}|null>(null)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  // Refresh the collection tree after a mutation and display failures.
  const act=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();await onRefresh()}catch(cause){setError(cause instanceof Error?cause.message:String(cause))}finally{setBusy(false)}}
  // Combine child folders and requests in their shared sort order.
  const entries=(cid:string|null,parent:string|null):Entry[]=>[
    ...folders.filter(item=>item.collection_id===cid&&item.parent_id===parent).map(record=>({kind:'folders' as const,record})),
    ...requests.filter(item=>item.collection_id===cid&&(item.folder_id??null)===parent).map(record=>({kind:'requests' as const,record}))
  ].sort((a,b)=>(a.record.position??0)-(b.record.position??0)||a.record.created_at.localeCompare(b.record.created_at))
  // Match the search text against a folder name or request fields.
  const matches=(entry:Entry):boolean=>[entry.record.name,entry.kind==='requests'?entry.record.url:'',entry.kind==='requests'?entry.record.method:''].join(' ').toLowerCase().includes(filter.toLowerCase())||entry.kind==='folders'&&entries(entry.record.collection_id,entry.record.id).some(matches)
  // Swap adjacent entries and persist their updated positions.
  const move=(items:Entry[],index:number,delta:number,cid:string,parent:string|null)=>void act(async()=>{
    const sorted=[...items];[sorted[index],sorted[index+delta]]=[sorted[index+delta],sorted[index]]
    await apiTesting.reorder({collection_id:cid,parent_id:parent,items:sorted.map(item=>({kind:item.kind,id:item.record.id,version:item.record.version}))})
  })
  // Render a folder level recursively with its matching requests and actions.
  function branch(cid:string|null,parent:string|null){
    const items=entries(cid,parent)
    return <ul className="api-tree-list">{items.filter(matches).map(entry=>{
      const index=items.indexOf(entry),record=entry.record
      const order=cid&&<span className="api-tree-order"><button type="button" aria-label={uiText("{0} 上移", record.name)} title={uiText("调整保存顺序")} disabled={busy||index===0} onClick={()=>move(items,index,-1,cid,parent)}>↑</button><button type="button" aria-label={uiText("{0} 下移", record.name)} disabled={busy||index===items.length-1} onClick={()=>move(items,index,1,cid,parent)}>↓</button></span>
      return <li key={record.id}>{entry.kind==='folders'?<details open><summary><span>{record.name}</span>{order}</summary><div className="api-tree-actions"><button type="button" disabled={busy} onClick={()=>setEditing({record:entry.record,collectionId:entry.record.collection_id,parentId:entry.record.parent_id})}>{uiText("编辑")}</button><button type="button" disabled={busy} onClick={()=>setEditing({record:null,collectionId:entry.record.collection_id,parentId:record.id})}>{uiText("添加子文件夹")}</button><button type="button" onClick={()=>onRun({collectionId:entry.record.collection_id,folderId:record.id})}>{uiText("运行文件夹")}</button></div>{branch(entry.record.collection_id,record.id)}</details>:<div className="api-tree-request"><button type="button" className={selectedId===record.id?'active':''} onClick={()=>onOpen(entry.record)}><span className="api-method">{entry.record.method}</span>{record.name}</button>{order}</div>}</li>
    })}</ul>
  }
  return <section aria-label={uiText("集合请求树")} className="api-tree">
    {error&&<p role="alert" className="api-error">{error}</p>}
    {collectionId&&<button type="button" className="text-button" onClick={()=>setEditing({record:null,collectionId,parentId:null})}>{uiText("新建文件夹")}</button>}
    {collections.filter(item=>!collectionId||item.id===collectionId).map(collection=><details key={collection.id} open><summary><strong>{collection.name}</strong></summary><div className="api-tree-actions"><button type="button" onClick={()=>setEditing({record:null,collectionId:collection.id,parentId:null})}>{uiText("添加文件夹")}</button><button type="button" onClick={()=>onRun({collectionId:collection.id})}>{uiText("运行集合")}</button></div>{branch(collection.id,null)}</details>)}
    {!collectionId&&requests.some(item=>!item.collection_id)&&<details open><summary>{uiText("未分组")}</summary>{branch(null,null)}</details>}
    {!requests.some(item=>(!collectionId||item.collection_id===collectionId)&&[item.name,item.url,item.method].join(' ').toLowerCase().includes(filter.toLowerCase()))&&<p className="muted">{uiText("没有匹配的请求。")}</p>}
    {editing&&<FolderEditor key={editing.record?.id??`${editing.collectionId}:${editing.parentId}`} folders={folders} initial={editing.record} collectionId={editing.collectionId} parentId={editing.parentId} busy={busy}
      onCancel={()=>setEditing(null)} onSave={value=>act(async()=>{await apiTesting.saveFolder(value,editing.record??undefined);setEditing(null)})}
      onDelete={editing.record?()=>act(async()=>{await apiTesting.remove('folders',editing.record!.id);setEditing(null)}):undefined}/>}
  </section>
}

// Edit a folder's details and save it under the selected collection.
function FolderEditor({initial,collectionId,parentId,folders,busy,onSave,onCancel,onDelete}:{initial:FolderRecord|null;collectionId:string;parentId:string|null;folders:FolderRecord[];busy:boolean;onSave:(value:Folder)=>Promise<void>;onCancel:()=>void;onDelete?:()=>Promise<void>}){
  const [draft,setDraft]=useState<Folder>(initial?configuration(initial):{name:'',collection_id:collectionId,parent_id:parentId,description:'',position:0})
  return <section className="api-folder-editor" aria-label={uiText("文件夹编辑")}><h3>{initial?uiText("编辑文件夹"):uiText("新建文件夹")}</h3><label className="field"><span>{uiText("文件夹名称")}</span><input value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label><label className="field"><span>{uiText("父文件夹")}</span><select value={draft.parent_id??''} onChange={event=>setDraft({...draft,parent_id:event.target.value||null})}><option value="">{uiText("集合根目录")}</option>{folders.filter(item=>item.collection_id===collectionId&&item.id!==initial?.id).map(item=><option key={item.id} value={item.id}>{folderPath(item,folders)} · {item.id.slice(0,6)}</option>)}</select></label><label className="field"><span>{uiText("文件夹描述")}</span><textarea value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label><div className="api-toolbar"><button type="button" className="primary-button" disabled={busy||!draft.name.trim()} onClick={()=>void onSave(draft)}>{uiText("保存文件夹")}</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{uiText("关闭")}</button>{onDelete&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>{if(window.confirm(uiText("删除此空文件夹？")))void onDelete()}}>{uiText("删除文件夹")}</button>}</div></section>
}
