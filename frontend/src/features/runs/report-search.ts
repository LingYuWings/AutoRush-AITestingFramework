import type {PlanRecord,RunRecord} from '../../shared/api'
const labels:Record<string,string>={passed:'通过',failed:'失败',blocked:'阻塞',error:'错误',skipped:'跳过'}
export function filterReports(runs:RunRecord[],plans:Pick<PlanRecord,'id'|'name'>[],query:string):RunRecord[] {
  const needle=query.trim().toLocaleLowerCase()
  return runs.filter(run=>[run.id,run.plan_id,plans.find(p=>p.id===run.plan_id)?.name,run.status,labels[run.status],run.termination_reason,
    run.created_at,...run.cases.map(c=>c.title)].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
}
