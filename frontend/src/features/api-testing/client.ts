import {api,request} from '../../shared/api'
import type {ApiRequest,ApiRequestRecord,Collection,CollectionRecord,ApiExecution,CollectionResult,ImportResult,Folder,FolderRecord} from './types'

const prefix='/api/v1/api-testing'
async function call<T>(path:string,init?:RequestInit):Promise<T>{
  if(!api.getOperatorToken()) await authorizeApi()
  return request<T>(prefix+path,init)
}
export async function authorizeApi(){api.setOperatorToken((await api.operatorSession()).operator_token)}
const post=<T>(path:string,payload:unknown,signal?:AbortSignal)=>call<T>(path,{method:'POST',body:JSON.stringify(payload),signal})
function save<T>(kind:string,payload:unknown,previous?:{id:string;version:number}){
  return previous?call<T>(`/${kind}/${encodeURIComponent(previous.id)}?expected_version=${previous.version}`,{method:'PUT',body:JSON.stringify(payload)}):post<T>(`/${kind}`,payload)
}
export const apiTesting={
  capabilities:()=>call<{allowed_hosts:string[];max_response_bytes:number;history_limit:number}>('/capabilities'),
  collections:()=>call<CollectionRecord[]>('/collections'),requests:()=>call<ApiRequestRecord[]>('/requests'),
  environments:()=>call<CollectionRecord[]>('/environments'),history:()=>call<ApiExecution[]>('/history'),
  folders:()=>call<FolderRecord[]>('/folders'),
  saveFolder:(payload:Folder,previous?:FolderRecord)=>save<FolderRecord>('folders',payload,previous),
  reorder:(payload:{collection_id:string;parent_id:string|null;items:{kind:'requests'|'folders';id:string;version:number}[]})=>post('/tree/reorder',payload),
  historyDetail:(id:string)=>call<ApiExecution>(`/history/${encodeURIComponent(id)}`),
  historyRequest:(id:string)=>call<{request:ApiRequest}>(`/history/${encodeURIComponent(id)}/request`),
  saveRequest:(payload:ApiRequest,previous?:ApiRequestRecord)=>save<ApiRequestRecord>('requests',payload,previous),
  saveCollection:(payload:Collection,previous?:CollectionRecord)=>save<CollectionRecord>('collections',payload,previous),
  saveEnvironment:(payload:Collection,previous?:CollectionRecord)=>save<CollectionRecord>('environments',payload,previous),
  remove:(kind:'requests'|'collections'|'environments'|'folders',id:string)=>call<{deleted:boolean}>(`/${kind}/${encodeURIComponent(id)}`,{method:'DELETE'}),
  execute:(spec:ApiRequest,environmentId:string|null,requestId:string|null,signal?:AbortSignal)=>post<ApiExecution>('/execute',{request:spec,environment_id:environmentId,request_id:requestId},signal),
  runCollection:(id:string,environmentId:string|null,signal?:AbortSignal)=>post<CollectionResult>(`/collections/${encodeURIComponent(id)}/run`,{environment_id:environmentId},signal),
  collectionCase:(id:string)=>post<Parameters<typeof api.createCase>[0]>(`/collections/${encodeURIComponent(id)}/case-draft`,{}),
  import:(format:string,content:unknown)=>post<ImportResult>('/import',{format,content}),
  export:(payload:Record<string,unknown>)=>post<{filename:string;content:string}>('/export',payload),
  snapshot:(spec:ApiRequest,requestId?:string)=>post<Record<string,unknown>>('/snapshots',{request:spec,request_id:requestId}),
  getSnapshot:(id:string)=>call<{request:ApiRequest;collection_variables:unknown[]}>(`/snapshots/${encodeURIComponent(id)}`),
}
export {call as apiCall}
export function downloadText(filename:string,content:string){
  const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}))
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
