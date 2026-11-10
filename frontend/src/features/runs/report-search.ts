import { uiText } from '../../shared/i18n.ts'
import type {PlanRecord,RunRecord} from '../../shared/api'
const labels:Record<string,string>={passed:uiText("通过"),failed:uiText("失败"),blocked:uiText("阻塞"),error:uiText("错误"),skipped:uiText("跳过")}
// Filter reports by status and searchable run or plan details.
export function filterReports(runs:RunRecord[],plans:Pick<PlanRecord,'id'|'name'>[],query:string):RunRecord[] {
  const needle=query.trim().toLocaleLowerCase()
  return runs.filter(run=>[run.id,run.plan_id,plans.find(p=>p.id===run.plan_id)?.name,run.status,labels[run.status],run.termination_reason,
    run.created_at,...run.cases.map(c=>c.title)].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
}
