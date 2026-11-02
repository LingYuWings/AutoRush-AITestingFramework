import {api,request,type CaseRecord,type PlanPayload,type StepResult,type ResultStatus} from '../../shared/api'
export type DebugCase=Pick<CaseRecord,'title'|'description'|'execution_mode'|'platform'|'steps'|'postconditions'>
export type DebugTargets=Omit<PlanPayload,'name'|'environment'|'case_ids'|'capture_screenshots'>
export type DebugSelection={read?:()=>DebugCase;source?:CaseRecord;saved?:boolean;sessionId:string}
export type DebugSummary={id:string;state:'running'|'stopping'|'finished'|'interrupted';title:string;source_case_id:string|null;source_version:number|null;session_id:string|null;unsaved:boolean;execution_mode:string;platform:string;created_at:string;status:ResultStatus|null}
export type DebugRun=DebugSummary&{termination_reason:string|null;result:{title:string;status:ResultStatus;steps:StepResult[]}|null;progress:{completed_cases?:{status:ResultStatus;steps:StepResult[]}[];active?:{steps?:StepResult[];active_step?:{order:number;intent:string;expected_result:string;traces:unknown[]};pending_action?:unknown}}}
export const debugClient={
  authorize:async()=>{if(!api.getOperatorToken())api.setOperatorToken((await api.operatorSession()).operator_token)},
  list:(source?:string,session?:string)=>request<DebugSummary[]>('/api/v1/case-debug-runs'+(source?'?source_case_id='+encodeURIComponent(source):session?'?session_id='+encodeURIComponent(session):'')),
  get:(id:string)=>request<DebugRun>('/api/v1/case-debug-runs/'+encodeURIComponent(id)),
  start:(value:{idempotency_key:string;source_case_id?:string;source_version?:number;session_id?:string;case?:DebugCase;targets:DebugTargets})=>request<DebugRun>('/api/v1/case-debug-runs',{method:'POST',body:JSON.stringify(value)}),
  cancel:(id:string)=>request<DebugRun>('/api/v1/case-debug-runs/'+encodeURIComponent(id)+'/cancel',{method:'POST'}),
}
