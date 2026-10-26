import type { AgentOptions,CaseRecord, DesktopTarget, PlanPayload } from '../../shared/api'
export type PlanForm={name:string;environment:string;selected:string[];apiBase:string;webBase:string;deviceId:string;androidPackage:string;
  captureScreenshots:boolean;webHeadless:boolean;viewportWidth:string;viewportHeight:string;desktopTarget:DesktopTarget|null;desktopDelay:string;agentOptions?:AgentOptions}
export function buildPlanPayload(form:PlanForm,cases:Pick<CaseRecord,'steps'|'postconditions'|'execution_mode'>[]):PlanPayload {
  const agent=cases.some(c=>c.execution_mode==='agent')
  if(agent&&!form.agentOptions?.provider_config_id)throw new Error('请选择已验证的执行模型')
  const drivers=new Set(cases.flatMap(c=>[...c.steps,...c.postconditions].map(s=>s.driver)))
  if(drivers.has('desktop')&&(!form.desktopTarget||!form.captureScreenshots)) throw new Error('请选择桌面目标窗口并启用每步截图')
  const width=Number(form.viewportWidth),height=Number(form.viewportHeight),delay=Number(form.desktopDelay)
  if(drivers.has('web')&&(!Number.isInteger(width)||width<320||width>3840||!Number.isInteger(height)||height<240||height>2160)) throw new Error('浏览器视口超出支持范围')
  if(drivers.has('desktop')&&(!Number.isInteger(delay)||delay<0||delay>10)) throw new Error('准备时间需为 0..10 秒')
  return {name:form.name.trim(),environment:form.environment.trim(),case_ids:form.selected,
    ...(agent?{agent_options:form.agentOptions}:{}),
    api_base_url:drivers.has('api')?form.apiBase.trim()||null:null,web_base_url:drivers.has('web')?form.webBase.trim()||null:null,
    android_device_id:drivers.has('android')?form.deviceId.trim()||null:null,android_package:drivers.has('android')?form.androidPackage.trim()||null:null,
    web_headless:drivers.has('web')?form.webHeadless:true,web_viewport:drivers.has('web')?{width,height}:{width:1280,height:800},
    desktop_target:drivers.has('desktop')?form.desktopTarget:null,desktop_start_delay_seconds:drivers.has('desktop')?delay:3,
    capture_screenshots:[...drivers].some(d=>d!=='api')&&(agent||form.captureScreenshots)}
}
