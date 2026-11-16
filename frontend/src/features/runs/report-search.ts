import { uiText } from '../../shared/i18n.ts'
import type {PlanRecord,RunSummary} from '../../shared/api'
const labels:Record<string,string>={passed:uiText("通过"),failed:uiText("失败"),blocked:uiText("阻塞"),error:uiText("错误"),skipped:uiText("跳过")}
// Filter reports by status and searchable run or plan details.
export function filterReports(runs:RunSummary[],plans:Pick<PlanRecord,'id'|'name'>[],query:string):RunSummary[] {
  const needle=query.trim().toLocaleLowerCase()
  if (!needle) return runs
  const names = new Map(plans.map(plan => [plan.id, plan.name]))
  return runs.filter(run=>[run.id,run.plan_id,names.get(run.plan_id),run.status,labels[run.status],run.termination_reason,
    run.created_at,...run.cases.map(c=>c.title)].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
}
