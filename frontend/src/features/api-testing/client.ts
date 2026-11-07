import {api,ApiRequestError,request} from '../../shared/api.ts'
import type {ApiRequest,ApiRequestRecord,Collection,CollectionRecord,ApiExecution,CollectionResult,ImportResult,Folder,FolderRecord} from './types'

const prefix='/api/v1/api-testing'
let authorization:Promise<void>|undefined

// Share an in-flight operator authorization across API requests.
export function authorizeApi():Promise<void>{
  authorization??=api.operatorSession()
    .then(session=>{api.setOperatorToken(session.operator_token)})
    .finally(()=>{authorization=undefined})
  return authorization
}

// Run a privileged operation and refresh authorization when the token is rejected.
export async function withApiAuthorization<T>(operation:()=>Promise<T>,signal?:AbortSignal|null):Promise<T>{
  signal?.throwIfAborted()
  if(!api.getOperatorToken())await authorizeApi()
  signal?.throwIfAborted()
  const token=api.getOperatorToken()
  try{return await operation()}
  catch(cause){
    if(!(cause instanceof ApiRequestError)||![401,403].includes(cause.status))throw cause
    signal?.throwIfAborted()
    const current=api.getOperatorToken()
    if(!current||current===token)await authorizeApi()
    signal?.throwIfAborted()
    return operation()
  }
}

// Send an authorized request relative to the API testing endpoint.
const call=<T>(path:string,init?:RequestInit)=>withApiAuthorization(()=>request<T>(prefix+path,init),init?.signal)
// Post a JSON payload to an API testing endpoint.
const post=<T>(path:string,payload:unknown,signal?:AbortSignal)=>call<T>(path,{method:'POST',body:JSON.stringify(payload),signal})
// Create a resource or update it using its last known version.
function save<T>(kind:string,payload:unknown,previous?:{id:string;version:number}){
  return previous?call<T>(`/${kind}/${encodeURIComponent(previous.id)}?expected_version=${previous.version}`,{method:'PUT',body:JSON.stringify(payload)}):post<T>(`/${kind}`,payload)
}
export const apiTesting={
  // Fetch API testing limits and the allowed host list.
  capabilities:()=>call<{allowed_hosts:string[];max_response_bytes:number;history_limit:number}>('/capabilities'),
  // List saved request collections.
  collections:()=>call<CollectionRecord[]>('/collections'),/* List saved API requests across collections. */ requests:()=>call<ApiRequestRecord[]>('/requests'),
  // List reusable API environments.
  environments:()=>call<CollectionRecord[]>('/environments'),/* List recent single-request executions. */ history:()=>call<ApiExecution[]>('/history'),
  // List folders used to build the collection tree.
  folders:()=>call<FolderRecord[]>('/folders'),
  // Create or update a folder with version checking.
  saveFolder:(payload:Folder,previous?:FolderRecord)=>save<FolderRecord>('folders',payload,previous),
  // Persist the new ordering for siblings in the collection tree.
  reorder:(payload:{collection_id:string;parent_id:string|null;items:{kind:'requests'|'folders';id:string;version:number}[]})=>post('/tree/reorder',payload),
  // Fetch the stored execution details for one history entry.
  historyDetail:(id:string)=>call<ApiExecution>(`/history/${encodeURIComponent(id)}`),
  // Recover the request configuration associated with a history entry.
  historyRequest:(id:string)=>call<{request:ApiRequest}>(`/history/${encodeURIComponent(id)}/request`),
  // Create or update a saved request with version checking.
  saveRequest:(payload:ApiRequest,previous?:ApiRequestRecord)=>save<ApiRequestRecord>('requests',payload,previous),
  // Save a collection's details and shared variables.
  saveCollection:(payload:Collection,previous?:CollectionRecord)=>save<CollectionRecord>('collections',payload,previous),
  // Save an environment and its variables.
  saveEnvironment:(payload:Collection,previous?:CollectionRecord)=>save<CollectionRecord>('environments',payload,previous),
  // Delete a resource of the requested kind by ID.
  remove:(kind:'requests'|'collections'|'environments'|'folders',id:string)=>call<{deleted:boolean}>(`/${kind}/${encodeURIComponent(id)}`,{method:'DELETE'}),
  // Run one request with its selected environment and optional source ID.
  execute:(spec:ApiRequest,environmentId:string|null,requestId:string|null,signal?:AbortSignal)=>post<ApiExecution>('/execute',{request:spec,environment_id:environmentId,request_id:requestId},signal),
  // Execute a collection with the selected environment.
  runCollection:(id:string,environmentId:string|null,signal?:AbortSignal)=>post<CollectionResult>(`/collections/${encodeURIComponent(id)}/run`,{environment_id:environmentId},signal),
  // Prepare a test case draft from a collection's saved requests.
  collectionCase:(id:string)=>post<Parameters<typeof api.createCase>[0]>(`/collections/${encodeURIComponent(id)}/case-draft`,{}),
  // Convert uploaded request definitions into saved API resources.
  import:(format:string,content:unknown)=>post<ImportResult>('/import',{format,content}),
  // Generate an export file from the selected API resources.
  export:(payload:Record<string,unknown>)=>post<{filename:string;content:string}>('/export',payload),
  // Store a request snapshot suitable for embedding in a test case.
  snapshot:(spec:ApiRequest,requestId?:string)=>post<Record<string,unknown>>('/snapshots',{request:spec,request_id:requestId}),
  // Load a frozen request and its inherited collection variables.
  getSnapshot:(id:string)=>call<{request:ApiRequest;collection_variables:unknown[]}>(`/snapshots/${encodeURIComponent(id)}`),
}
export {call as apiCall}
// Trigger a JSON download and release its temporary object URL.
export function downloadText(filename:string,content:string){
  const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}))
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
