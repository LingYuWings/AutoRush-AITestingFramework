import {api,API_BASE,ApiRequestError,request} from '../../shared/api.ts'
import {authorizeApi,withApiAuthorization} from '../api-testing/client.ts'
import type {ImportCommit,ImportOptions,ImportSession,ImportCandidate,ImportResult} from './types'

const prefix='/api/v1/case-imports'
let fallbackSession=''
// Retry import calls after renewing local authorization on a service-unavailable response.
async function authorized<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  try{return await withApiAuthorization(operation,signal)}catch(cause){
    if(!(cause instanceof ApiRequestError)||cause.status!==503)throw cause
    signal?.throwIfAborted();await authorizeApi();signal?.throwIfAborted()
    return operation()
  }
}
// Reuse the tab's import identity, with an in-memory fallback when storage fails.
export function importSessionId():string{
  try{
    let id=sessionStorage.getItem('autorush-case-import-session')
    if(!id){id=crypto.randomUUID();sessionStorage.setItem('autorush-case-import-session',id)}
    return id
  }catch{return fallbackSession||=crypto.randomUUID()}
}
// Store or retrieve the most recent import ID for recovery in this tab.
export function rememberedImport(id?:string):string|null{
  try{if(id)sessionStorage.setItem('autorush-case-import-id',id);return sessionStorage.getItem('autorush-case-import-id')}catch{return null}
}
export const importClient={
  // Upload the source file and options as a multipart request for preview.
  preview:(file:File,options:ImportOptions,session:string,signal?:AbortSignal)=>authorized(()=>{
    const form=new FormData();form.set('file',file);form.set('options',JSON.stringify(options));form.set('session_id',session)
    return request<ImportSession>(prefix+'/preview',{method:'POST',body:form,signal})
  },signal),
  // Retrieve an earlier import within the owning session.
  get:(id:string,session:string,signal?:AbortSignal)=>authorized(()=>request<ImportSession>(`${prefix}/${encodeURIComponent(id)}?session_id=${encodeURIComponent(session)}`,{signal}),signal),
  // Ask the server to validate candidate edits before commit.
  validate:(id:string,payload:ImportCommit,signal?:AbortSignal)=>authorized(()=>request<{candidates:ImportCandidate[]}>(`${prefix}/${encodeURIComponent(id)}/validate`,{method:'POST',body:JSON.stringify(payload),signal}),signal),
  // Create case drafts from the selected import candidates.
  commit:(id:string,payload:ImportCommit,signal?:AbortSignal)=>authorized(()=>request<ImportResult>(`${prefix}/${encodeURIComponent(id)}/commit`,{method:'POST',body:JSON.stringify(payload),signal}),signal),
  // Download the Markdown import template using operator authorization.
  template:()=>authorized(async()=>{
    const response=await fetch(API_BASE+prefix+'/template',{cache:'no-store',headers:{'X-Autorush-Operator-Token':api.getOperatorToken()}})
    if(!response.ok)throw new ApiRequestError('模板下载失败',response.status)
    const url=URL.createObjectURL(await response.blob()),link=document.createElement('a')
    link.href=url;link.download='autorush-cases.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }),
}
