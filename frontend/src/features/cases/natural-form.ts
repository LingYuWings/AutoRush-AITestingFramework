import type {CaseRecord,DriverKind,StepSpec} from '../../shared/api'
export type NaturalStep={id:string;intent:string;expected_result:string;driver:DriverKind;always_run:boolean}
export const newNaturalStep=():NaturalStep=>({id:crypto.randomUUID(),intent:'',expected_result:'',driver:'web',always_run:false})
export function buildNaturalCase(form:{title:string;description:string;steps:NaturalStep[];postconditions:NaturalStep[]}):Pick<CaseRecord,'title'|'description'|'execution_mode'|'steps'|'postconditions'> {
  if(!form.title.trim()||!form.steps.length)throw new Error('请填写标题和执行步骤')
  const compile=(step:NaturalStep,index:number):StepSpec=>{
    if(!step.intent.trim()||!step.expected_result.trim())throw new Error('每个步骤都需要操作意图和预期结果')
    return {order:index+1,intent:step.intent.trim(),expected_result:step.expected_result.trim(),driver:step.driver,always_run:step.always_run,operation:'',parameters:{},assertions:[]}
  }
  return {title:form.title.trim(),description:form.description.trim(),execution_mode:'agent',steps:form.steps.map(compile),postconditions:form.postconditions.map(compile)}
}
