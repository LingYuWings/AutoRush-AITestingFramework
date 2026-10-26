import type {AgentExecution,ResultStatus} from '../../shared/api'
export function executionSummary(execution:Pick<AgentExecution,'state'|'progress'>&Partial<Pick<AgentExecution,'termination_reason'>>):{rounds:number;status:ResultStatus|null} {
  const cases=execution.progress.completed_cases??[]
  const rounds=cases.reduce((total,item)=>total+item.steps.reduce((count,step)=>{
    const agent=step.evidence.agent as {rounds_used?:number}|undefined
    return count+(typeof agent?.rounds_used==='number'?agent.rounds_used:0)
  },0),0)+(execution.progress.active?.rounds_used??0)
  const terminal=['finished','interrupted'].includes(execution.state)
  const status=terminal?(execution.termination_reason||execution.state==='interrupted'?'blocked':(['error','blocked','failed','skipped'] as const).find(s=>cases.some(c=>c.status===s))??'passed'):null
  return {rounds,status}
}
