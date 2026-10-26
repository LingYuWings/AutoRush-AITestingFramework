import type {AgentExecution} from '../../shared/api'
import AgentTrace from './AgentTrace'
import {executionSummary} from './agent-summary'
import {StatusBadge} from '../../components/ui'
export default function AgentProgress({execution,onCancel,busy}:{execution:AgentExecution;onCancel:()=>void;busy:boolean}) {
  const active=['running','stopping'].includes(execution.state)
  const summary=executionSummary(execution)
  return <section className="surface agent-progress"><h3>模型执行 #{execution.id.slice(0,8)}</h3><p role="status">{({running:'运行中',stopping:'正在停止',finished:'已结束',interrupted:'已中断'})[execution.state]} · 已决策 {summary.rounds} 轮 {summary.status&&<StatusBadge status={summary.status}/>}</p>
    {execution.progress.active?.active_step&&<><strong>{execution.progress.active?.active_step.intent}</strong><AgentTrace live evidence={{agent:execution.progress.active?.active_step}}/></>}
    {execution.progress.active?.pending_action&&<p>动作已发送，等待结果；中断后不会自动重放。</p>}
    {execution.termination_reason&&<p>{execution.termination_reason}</p>}
    {active&&<button className="secondary-button" disabled={busy||execution.state==='stopping'} onClick={onCancel}>停止执行</button>}
    {execution.final_run_id&&<p>报告已保存，可在运行报告中查看 #{execution.final_run_id.slice(0,8)}</p>}
  </section>
}
