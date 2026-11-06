import type {DebugCase,DebugTargets} from './client'
import type {DesktopTarget} from '../../shared/api'
export type DebugForm={apiBase:string;apiEnvironmentId:string;webBase:string;deviceId:string;androidPackage:string;webHeadless:boolean;viewportWidth:string;viewportHeight:string;desktopTarget:DesktopTarget|null;desktopDelay:string;providerId:string;rounds:number;caseRounds:number;modelTimeout:number;caseTimeout:number}
// Supply viewport, timing, and model limits for a fresh debug form.
export const initialDebugForm=():DebugForm=>({apiBase:'',apiEnvironmentId:'',webBase:'',deviceId:'',androidPackage:'',webHeadless:false,viewportWidth:'1280',viewportHeight:'800',desktopTarget:null,desktopDelay:'3',providerId:'',rounds:8,caseRounds:40,modelTimeout:90,caseTimeout:180})
// Normalize a case snapshot and require intent and expectations where needed.
export function validateDebugCase(value:DebugCase):DebugCase {
  const snapshot=structuredClone(value)
  snapshot.title=snapshot.title.trim()
  if(!snapshot.title)throw new Error('请填写用例标题')
  if(!snapshot.steps.length)throw new Error('至少需要一个执行步骤')
  for(const step of [...snapshot.steps,...snapshot.postconditions]){
    step.intent=step.intent.trim()
    if(!step.intent)throw new Error('请填写每个步骤的操作内容')
    if(snapshot.execution_mode==='agent'&&!(step.driver==='api'&&step.operation==='api.request')){
      step.expected_result=step.expected_result?.trim()
      if(!step.expected_result)throw new Error('请填写自然语言步骤的预期结果')
    }
  }
  return snapshot
}
// Build validated target settings only for drivers present in the case.
export function debugTargets(form:DebugForm,value:DebugCase):DebugTargets {
  const drivers=new Set([...value.steps,...value.postconditions].map(s=>s.driver))
  const result:DebugTargets={}
  if(drivers.has('api')){
    if(form.apiBase.trim())result.api_base_url=form.apiBase.trim()
    if(form.apiEnvironmentId)result.api_environment_id=form.apiEnvironmentId
  }
  if(drivers.has('web')){
    if(!form.webBase.trim())throw new Error('请填写 Web 基础地址')
    const width=Number(form.viewportWidth),height=Number(form.viewportHeight)
    if(!Number.isInteger(width)||width<320||width>3840||!Number.isInteger(height)||height<240||height>2160)throw new Error('浏览器视口超出支持范围')
    Object.assign(result,{web_base_url:form.webBase.trim(),web_headless:form.webHeadless,web_viewport:{width,height}})
  }
  if(drivers.has('android')){
    if(!form.deviceId||!form.androidPackage.trim())throw new Error('请选择手机并填写包名')
    Object.assign(result,{android_device_id:form.deviceId,android_package:form.androidPackage.trim()})
  }
  if(drivers.has('desktop')){
    if(!form.desktopTarget)throw new Error('请刷新并选择桌面目标窗口')
    const delay=Number(form.desktopDelay)
    if(!Number.isInteger(delay)||delay<0||delay>10)throw new Error('窗口准备时间需为 0..10 秒')
    Object.assign(result,{desktop_target:form.desktopTarget,desktop_start_delay_seconds:delay})
  }
  if(value.execution_mode==='agent'){
    if(!form.providerId)throw new Error('请选择已验证的执行模型')
    result.agent_options={provider_config_id:form.providerId,max_rounds_per_step:form.rounds,max_rounds_per_case:form.caseRounds,model_timeout_seconds:form.modelTimeout,case_timeout_seconds:form.caseTimeout}
  }
  return result
}
