import {api} from '../../shared/api'
import {apiCall,authorizeApi} from './client'
import type {ApiExecution} from './types'

export type Page<T>={items:T[];total:number;offset:number;limit:number}
export type Dataset={format:'csv'|'json';content:string}
export type DatasetPreview={row_count:number;columns:string[];preview:Record<string,unknown>[];preview_truncated:boolean}
export type RunCommand={collection_id:string;folder_id:string|null;request_ids:string[];environment_id:string|null;iterations:number|null;data:Dataset|null;delay_ms:number;timeout_seconds:number;stop_on_failure:boolean;idempotency_key:string}
export type ApiRun={id:string;name:string;state:'queued'|'running'|'cancelling'|'completed'|'cancelled'|'interrupted';status:ApiExecution['status']|null;created_at:string;started_at:string|null;finished_at:string|null;completed:number;total:number;current_iteration:number|null;current_request:string|null;detail:string;elapsed_ms:number;counts:Record<ApiExecution['status'],number>;retained_bytes:number;source:{collection_id:string;collection_name:string;folder_id:string|null;environment_id:string|null;environment_name:string|null;request_ids:string[];request_versions:number[];iterations:number;dataset_row_count:number;delay_ms:number;timeout_seconds:number;stop_on_failure:boolean}}
export type RunStep=ApiExecution&{seq:number;iteration:number;request_version:number;response_omitted?:string}
const path='/runner/runs'
const post=<T>(url:string,payload:unknown={})=>apiCall<T>(url,{method:'POST',body:JSON.stringify(payload)})
export const runnerApi={
  preview:(data:Dataset)=>post<DatasetPreview>('/datasets/preview',data),
  start:(value:RunCommand)=>post<ApiRun>(path,value),
  list:(search='',status='',offset=0)=>apiCall<Page<ApiRun>>(`${path}?${new URLSearchParams({search,status,offset:String(offset),limit:'20'})}`),
  get:(id:string)=>apiCall<ApiRun>(`${path}/${encodeURIComponent(id)}`),
  steps:(id:string,offset=0)=>apiCall<Page<RunStep>>(`${path}/${encodeURIComponent(id)}/steps?offset=${offset}&limit=25`),
  detail:(id:string,seq:number)=>apiCall<RunStep>(`${path}/${encodeURIComponent(id)}/steps/${seq}`),
  cancel:(id:string)=>post<ApiRun>(`${path}/${encodeURIComponent(id)}/cancel`),
  rerun:(id:string)=>post<ApiRun>(`${path}/${encodeURIComponent(id)}/rerun`,{idempotency_key:crypto.randomUUID()}),
  download:async(id:string,format:'json'|'html'|'junit')=>{
    if(!api.getOperatorToken())await authorizeApi()
    const base=window.location.protocol==='app:'?'http://127.0.0.1:8000':''
    const response=await fetch(`${base}/api/v1/api-testing${path}/${encodeURIComponent(id)}/export?format=${format}`,{cache:'no-store',headers:{'X-Autorush-Operator-Token':api.getOperatorToken()}})
    if(!response.ok)throw new Error('报告下载失败：'+response.status)
    const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download=`api-run-${id}.${format==='junit'?'xml':format}`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
}
export const runActive=(run:ApiRun|null)=>!!run&&['queued','running','cancelling'].includes(run.state)
