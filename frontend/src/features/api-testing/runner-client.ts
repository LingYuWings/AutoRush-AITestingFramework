import { uiText } from '../../shared/i18n.ts'
import {api,API_BASE,ApiRequestError} from '../../shared/api.ts'
import {apiCall,withApiAuthorization} from './client.ts'
import type {ApiExecution} from './types'

export type Page<T>={items:T[];total:number;offset:number;limit:number}
export type Dataset={format:'csv'|'json';content:string}
export type DatasetPreview={row_count:number;columns:string[];preview:Record<string,unknown>[];preview_truncated:boolean}
export type RunCommand={collection_id:string;folder_id:string|null;request_ids:string[];environment_id:string|null;iterations:number|null;data:Dataset|null;delay_ms:number;timeout_seconds:number;stop_on_failure:boolean;idempotency_key:string}
export type ApiRun={id:string;name:string;state:'queued'|'running'|'cancelling'|'completed'|'cancelled'|'interrupted';status:ApiExecution['status']|null;created_at:string;started_at:string|null;finished_at:string|null;completed:number;total:number;current_iteration:number|null;current_request:string|null;detail:string;elapsed_ms:number;counts:Record<ApiExecution['status'],number>;retained_bytes:number;source:{collection_id:string;collection_name:string;folder_id:string|null;environment_id:string|null;environment_name:string|null;request_ids:string[];request_versions:number[];iterations:number;dataset_row_count:number;delay_ms:number;timeout_seconds:number;stop_on_failure:boolean}}
export type RunStep=ApiExecution&{seq:number;iteration:number;request_version:number;response_omitted?:string}
const path='/runner/runs'
const call=apiCall
// Send a JSON command through the authorized API client.
const post=<T>(url:string,payload:unknown={})=>call<T>(url,{method:'POST',body:JSON.stringify(payload)})
export const runnerApi={
  // Inspect dataset columns and rows before scheduling a run.
  preview:(data:Dataset)=>post<DatasetPreview>('/datasets/preview',data),
  // Queue a collection run using the submitted command.
  start:(value:RunCommand)=>post<ApiRun>(path,value),
  // Fetch a filtered page of prior collection runs.
  list:(search='',status='',offset=0)=>call<Page<ApiRun>>(`${path}?${new URLSearchParams({search,status,offset:String(offset),limit:'20'})}`),
  // Fetch a run's current state by ID.
  get:(id:string,signal?:AbortSignal)=>call<ApiRun>(`${path}/${encodeURIComponent(id)}`,{signal}),
  // Fetch a page of request results for a run.
  steps:(id:string,offset=0,signal?:AbortSignal)=>call<Page<RunStep>>(`${path}/${encodeURIComponent(id)}/steps?offset=${offset}&limit=25`,{signal}),
  // Fetch the full result for one execution step.
  detail:(id:string,seq:number,signal?:AbortSignal)=>call<RunStep>(`${path}/${encodeURIComponent(id)}/steps/${seq}`,{signal}),
  // Request cancellation of a queued or running batch.
  cancel:(id:string)=>post<ApiRun>(`${path}/${encodeURIComponent(id)}/cancel`),
  // Queue a fresh execution from a previous run using a new retry key.
  rerun:(id:string)=>post<ApiRun>(`${path}/${encodeURIComponent(id)}/rerun`,{idempotency_key:crypto.randomUUID()}),
  // Download an authorized run export in the requested format.
  download:(id:string,format:'json'|'html'|'junit')=>withApiAuthorization(async()=>{
    const base=API_BASE
    const response=await fetch(`${base}/api/v1/api-testing${path}/${encodeURIComponent(id)}/export?format=${format}`,{cache:'no-store',headers:{'X-Autorush-Operator-Token':api.getOperatorToken()}})
    if(!response.ok)throw new ApiRequestError(uiText("报告下载失败：")+response.status,response.status)
    const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download=`api-run-${id}.${format==='junit'?'xml':format}`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  })
}
// Identify states in which a run is still in progress.
export const runActive=(run:ApiRun|null)=>!!run&&['queued','running','cancelling'].includes(run.state)
