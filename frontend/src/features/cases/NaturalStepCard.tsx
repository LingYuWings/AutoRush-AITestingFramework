import type {DriverKind} from '../../shared/api'
import type {NaturalStep} from './natural-form'
export default function NaturalStepCard({step,index,cleanup,onChange,onRemove,lockDriver=false}:{step:NaturalStep;index:number;cleanup?:boolean;onChange:(step:NaturalStep)=>void;onRemove:()=>void;lockDriver?:boolean}) {
  return <section className="surface step-card"><div className="section-title"><strong>{cleanup?'后处理':'执行步骤'} {index+1}</strong><button type="button" className="secondary-button" onClick={onRemove}>删除{cleanup?'后处理':'步骤'}</button></div>
    <label className="field"><span>驱动</span><select disabled={lockDriver} value={step.driver} onChange={e=>onChange({...step,driver:e.target.value as DriverKind})}><option value="web">Web · Playwright</option><option value="desktop">Desktop · PyAutoGUI</option><option value="android">Android · Portal</option><option value="api">HTTP API</option></select></label>
    <label className="field"><span>操作意图</span><textarea required maxLength={2000} value={step.intent} onChange={e=>onChange({...step,intent:e.target.value})} placeholder="例如：搜索框输入 blue，点击提交"/></label>
    <label className="field"><span>预期结果</span><textarea required maxLength={2000} value={step.expected_result} onChange={e=>onChange({...step,expected_result:e.target.value})} placeholder="例如：页面显示 Submitted: blue"/></label>
    {cleanup&&<label className="check-line"><input type="checkbox" checked={step.always_run} onChange={e=>onChange({...step,always_run:e.target.checked})}/>步骤失败后仍执行（取消后停止）</label>}
  </section>
}
