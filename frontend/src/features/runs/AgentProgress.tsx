import { uiText } from '../../shared/i18n.ts'
import {useState} from 'react'
import type {AgentExecution} from '../../shared/api'
import AgentLiveDialog from './AgentLiveDialog'
import AgentTrace from './AgentTrace'
import {executionSummary} from './agent-summary'
import {StatusBadge} from '../../components/ui'
// Summarize an agent run's progress and available controls.
export default function AgentProgress({execution,onCancel,busy}:{execution:AgentExecution;onCancel:()=>void;busy:boolean}) {
  const [showOutput,setShowOutput]=useState(false)
  const active=['running','stopping'].includes(execution.state)
  const summary=executionSummary(execution)
  return <section className="surface agent-progress"><h3>{uiText("模型执行 #")}{execution.id.slice(0,8)}</h3><p role="status">{({running:uiText("运行中"),stopping:uiText("正在停止"),finished:uiText("已结束"),interrupted:uiText("已中断")})[execution.state]}{uiText(" · 已决策 ")}{summary.rounds}{uiText(" 轮 ")}{summary.status&&<StatusBadge status={summary.status}/>}</p>
    {execution.progress.active?.active_step&&<><strong>{execution.progress.active?.active_step.intent}</strong><AgentTrace live evidence={{agent:execution.progress.active?.active_step}}/></>}
    {execution.progress.active?.pending_action&&<p>{uiText("动作已发送，等待结果；中断后不会自动重放。")}</p>}
    {execution.termination_reason&&<p>{execution.termination_reason}</p>}
    {active&&<div className="agent-progress-actions">
      <button type="button" className="secondary-button accent" aria-haspopup="dialog" onClick={()=>setShowOutput(true)}>{uiText("查看实时输出")}</button>
      <button type="button" className="secondary-button" disabled={busy||execution.state==='stopping'} onClick={onCancel}>{uiText("停止执行")}</button>
    </div>}
    {showOutput&&<AgentLiveDialog executionId={execution.id} onClose={()=>setShowOutput(false)}/>}
    {execution.final_run_id&&<p>{uiText("报告已保存，可在运行报告中查看 #")}{execution.final_run_id.slice(0,8)}</p>}
  </section>
}
