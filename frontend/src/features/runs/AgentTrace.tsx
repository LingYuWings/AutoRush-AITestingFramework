import { uiText } from '../../shared/i18n.ts'
import type {AgentTraceRecord} from '../../shared/api'
import StepScreenshot from '../../components/StepScreenshot'
// Display agent decisions and verification records attached to step evidence.
export default function AgentTrace({evidence,authEpoch=0,live=false}:{evidence:Record<string,unknown>;authEpoch?:number;live?:boolean}) {
  const agent=evidence.agent as {expected_result?:string;verification_kind?:string;traces?:AgentTraceRecord[]}|undefined
  if(!agent)return null
  return <div className="agent-trace"><p>{uiText("预期：")}{agent.expected_result}{uiText(" · 验证方式：")}{agent.verification_kind==='visual'?uiText("模型视觉判断"):agent.verification_kind||uiText("未完成")}</p>
    {agent.traces?.map((trace,index)=><details key={index} open={live&&index===(agent.traces?.length??0)-1}><summary>{uiText("第 {0} 轮 · ", trace.round??index+1)}{trace.operation||uiText("决策")} · {trace.result?.status||trace.error||uiText("观察")}</summary>
      <p>{trace.brief_reason||trace.error}</p>{trace.model&&<small>{trace.model.latency_ms} ms · {trace.model.attempts}{uiText(" 次请求")}</small>}
      {trace.result?.detail&&<p>{trace.result.detail}</p>}{trace.verification_kind&&<p>{uiText("验证方式：")}{trace.verification_kind==='visual'?uiText("模型视觉判断"):trace.verification_kind}</p>}
      {trace.observation?.screenshot&&<StepScreenshot key={'before'+authEpoch} evidence={{screenshot:trace.observation.screenshot}}/>}
      {trace.result?.evidence&&<StepScreenshot key={'after'+authEpoch} evidence={trace.result.evidence}/>}
    </details>)}
  </div>
}
