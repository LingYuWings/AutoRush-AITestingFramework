import { uiText } from '../../shared/i18n.ts'
import type {DriverKind} from '../../shared/api'
import type {NaturalStep} from './natural-form'
import StepHeading from './StepHeading'
// Edit one natural-language action or cleanup step.
export default function NaturalStepCard({step,index,cleanup,onChange,onRemove,onMoveUp,onMoveDown,lockDriver=false}:{step:NaturalStep;index:number;cleanup?:boolean;onChange:(step:NaturalStep)=>void;onRemove:()=>void;onMoveUp?:()=>void;onMoveDown?:()=>void;lockDriver?:boolean}) {
  return <section className="step-card">
    <StepHeading index={index} cleanup={cleanup} title={cleanup?uiText("后处理步骤"):uiText("执行步骤")} driver={step.driver} onMoveUp={onMoveUp} onMoveDown={onMoveDown} onRemove={onRemove}/>
    {!lockDriver&&<label className="field"><span>{uiText("驱动")}</span><select value={step.driver} onChange={e=>onChange({...step,driver:e.target.value as DriverKind})}><option value="web">Web · Playwright</option><option value="desktop">Desktop · PyAutoGUI</option><option value="android">Android · Portal</option><option value="api">HTTP API</option></select></label>}
    <div className="field-grid">
      <label className="field"><span>{uiText("操作意图")}</span><textarea required rows={3} maxLength={2000} value={step.intent} onChange={e=>onChange({...step,intent:e.target.value})} placeholder={uiText("例如：搜索框输入 blue，点击提交")}/></label>
      <label className="field"><span>{uiText("预期结果")}</span><textarea required rows={3} maxLength={2000} value={step.expected_result} onChange={e=>onChange({...step,expected_result:e.target.value})} placeholder={uiText("例如：页面显示 Submitted: blue")}/></label>
    </div>
    {cleanup&&<label className="check-line"><input type="checkbox" checked={step.always_run} onChange={e=>onChange({...step,always_run:e.target.checked})}/>{uiText("前序步骤失败后仍执行（取消运行时停止）")}</label>}
  </section>
}
