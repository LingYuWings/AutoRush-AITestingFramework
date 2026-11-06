import StepScreenshot from '../../components/StepScreenshot'
import {StatusBadge} from '../../components/ui'
import AgentTrace from '../runs/AgentTrace'
import {ApiEvidence} from '../api-testing/ResponsePanel'
import type {DebugRun} from './client'

// Display completed or in-progress debug steps with their evidence.
export default function CaseDebugResults({run}:{run:DebugRun}){
  const active=run.progress.active
  const steps=run.result?.steps??[...(run.progress.completed_cases?.flatMap(c=>c.steps)??[]),...(active?.steps??[])]
  return <section className="debug-results" aria-label="调试执行结果">
    <div className="section-title"><h3>{run.title}</h3>{run.result&&<StatusBadge status={run.result.status}/>}</div>
    <p className="quiet-note">{run.platform} · {run.execution_mode==='agent'?'自然语言':'结构化'} · {run.unsaved?'未保存内容快照':`已保存 v${run.source_version??1}`} · {new Date(run.created_at).toLocaleString()} · #{run.id.slice(0,8)}</p>
    <p role="status">{({running:'调试运行中',stopping:'正在停止调试',finished:'调试已结束',interrupted:'调试已中断'})[run.state]}</p>
    {run.termination_reason&&<p className="inline-alert">{run.termination_reason}</p>}
    {steps.map((step,index)=><details key={`${step.order}-${index}`} className="debug-step" open={step.status!=='passed'}><summary><span>{step.order}. {step.intent}</span><StatusBadge status={step.status}/></summary><p>{step.detail}</p>
      {step.assertions.length>0&&<ul>{step.assertions.map((value,i)=><li key={i}>{value}</li>)}</ul>}
      <StepScreenshot evidence={step.evidence}/><AgentTrace evidence={step.evidence}/>{Boolean(step.evidence.api)&&<ApiEvidence value={step.evidence.api}/>}</details>)}
    {!run.result&&active?.active_step&&<section className="debug-step"><strong>正在执行：{active.active_step.intent}</strong><AgentTrace live evidence={{agent:active.active_step}}/>
      {Boolean(active.pending_action)&&<p className="quiet-note">动作已发送，等待结果。中断后不会自动重放。</p>}</section>}
  </section>
}
