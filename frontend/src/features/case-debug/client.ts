import {api,request,ApiRequestError,type CaseRecord,type PlanPayload,type StepResult,type ResultStatus} from '../../shared/api.ts'
export type DebugCase=Pick<CaseRecord,'title'|'description'|'execution_mode'|'platform'|'steps'|'postconditions'>
export type DebugTargets=Omit<PlanPayload,'name'|'environment'|'case_ids'|'capture_screenshots'>
export type DebugSelection={read?:()=>DebugCase;source?:CaseRecord;saved?:boolean;sessionId:string}
export type DebugSummary={id:string;state:'running'|'stopping'|'finished'|'interrupted';title:string;source_case_id:string|null;source_version:number|null;session_id:string|null;unsaved:boolean;execution_mode:string;platform:string;created_at:string;status:ResultStatus|null}
export type DebugRun=DebugSummary&{termination_reason:string|null;result:{title:string;status:ResultStatus;steps:StepResult[]}|null;progress:{completed_cases?:{status:ResultStatus;steps:StepResult[]}[];active?:{steps?:StepResult[];active_step?:{order:number;intent:string;expected_result:string;traces:unknown[]};pending_action?:unknown}}}
let authorization:Promise<void>|null=null
async function authorize(force=false):Promise<void>{
  if(authorization)return authorization
  if(!force&&api.getOperatorToken())return
  const previous=api.getOperatorToken()
  authorization=api.operatorSession().then(session=>{
    if(typeof session.operator_token!=='string'||!session.operator_token.trim())throw new Error('本机调试授权不可用')
    if(api.getOperatorToken()===previous)api.setOperatorToken(session.operator_token)
  }).finally(()=>{authorization=null})
  return authorization
}
async function authorized<T>(operation:()=>Promise<T>):Promise<T>{
  const sentToken=api.getOperatorToken()
  try{return await operation()}catch(cause){
    if(!(cause instanceof ApiRequestError)||![401,403,503].includes(cause.status))throw cause
    if(api.getOperatorToken()===sentToken)await authorize(true)
    return operation() // One retry only; POST retains the same frozen content and idempotency key.
  }
}
export const debugClient={
  authorize,
  list:(source?:string,session?:string)=>authorized(()=>request<DebugSummary[]>('/api/v1/case-debug-runs'+(source?'?source_case_id='+encodeURIComponent(source):session?'?session_id='+encodeURIComponent(session):''))),
  active:()=>authorized(()=>request<DebugSummary[]>('/api/v1/case-debug-runs?active_only=true')),
  get:(id:string)=>authorized(()=>request<DebugRun>('/api/v1/case-debug-runs/'+encodeURIComponent(id))),
  start:(value:{idempotency_key:string;source_case_id?:string;source_version?:number;session_id?:string;case?:DebugCase;targets:DebugTargets})=>authorized(()=>request<DebugRun>('/api/v1/case-debug-runs',{method:'POST',body:JSON.stringify(value)})),
  cancel:(id:string)=>authorized(()=>request<DebugRun>('/api/v1/case-debug-runs/'+encodeURIComponent(id)+'/cancel',{method:'POST'})),
}
