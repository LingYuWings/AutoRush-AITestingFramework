import { uiText } from '../../shared/i18n.ts'
import type {DriverKind} from '../../shared/api'
import type {ImportCandidate,ImportCommit,ImportDraft,ImportEntry} from './types'

// Turn server candidates into editable JSON rows with initial validation state.
export function initialEntries(candidates:ImportCandidate[]):ImportEntry[]{
  return candidates.map(original=>({original,text:JSON.stringify(original.draft,null,2),selected:original.valid,reviewed:false,valid:original.valid,dirty:false,diagnostics:original.diagnostics}))
}
// Parse candidate JSON and check the shape required by the import form.
export function readDraft(text:string):ImportDraft{
  const value=JSON.parse(text)
  // Accept the supported driver values and an omitted platform.
  const platform=(item:unknown)=>item==null||['web','android','desktop','api'].includes(item as string)
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.title!=='string'||typeof value.description!=='string'
    ||!platform(value.platform)||!Array.isArray(value.steps)||!Array.isArray(value.postconditions)
    ||[...value.steps,...value.postconditions].some(step=>!step||typeof step!=='object'||!platform(step.driver)||typeof step.intent!=='string'
      ||(step.expected_result!=null&&typeof step.expected_result!=='string')))
    throw new Error(uiText("内容须为包含标题、说明、步骤和后置步骤的用例 JSON 对象"))
  return value as ImportDraft
}
// Mark edited JSON as dirty and invalidate its last validation.
export function editEntry(entry:ImportEntry,text:string):ImportEntry{return {...entry,text,dirty:true,valid:false}}
// Record the server's validation outcome and diagnostics for an entry.
export function applyValidation(entry:ImportEntry,checked:ImportCandidate):ImportEntry{
  return {...entry,valid:checked.valid,dirty:false,diagnostics:checked.diagnostics}
}
// Build the commit payload from selected entries that passed validation.
export function makeCommit(entries:ImportEntry[],session:string,key:string,allowDuplicate:boolean):ImportCommit{
  const chosen=entries.filter(entry=>entry.selected)
  if(!chosen.length)throw new Error(uiText("请至少选择一个用例"))
  if(chosen.some(entry=>entry.dirty||!entry.valid))throw new Error(uiText("请先校验并修复选中的用例"))
  return {session_id:session,idempotency_key:key,allow_duplicate_file:allowDuplicate,selections:chosen.map(entry=>({candidate_id:entry.original.candidate_id,draft:readDraft(entry.text),acknowledge_source_issues:entry.reviewed}))}
}
// Update the draft's execution mode and remap its non-API steps.
export function changePlatform(draft:ImportDraft,platform:DriverKind):ImportDraft{
  // Apply the selected platform while preserving deterministic API steps.
  const steps=(values:ImportDraft['steps'])=>values.map(step=>({...step,driver:step.driver==='api'?'api':platform}))
  return {...draft,platform,execution_mode:platform==='api'?'structured':'agent',steps:steps(draft.steps),postconditions:steps(draft.postconditions)}
}
// Retain local edits when recovery returns the same import.
export function recoverEntries(currentId:string|undefined,nextId:string,candidates:ImportCandidate[],entries:ImportEntry[]):ImportEntry[]{
  return currentId===nextId?entries:initialEntries(candidates)
}
