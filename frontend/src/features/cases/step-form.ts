import type { AssertionKind, DriverKind, StepSpec } from '../../shared/api'

export type EditableAssertion = { id:string; kind:AssertionKind; expected:string; path:string }
export type EditableStep = {
  id:string; intent:string; driver:DriverKind; operation:string; method:string; path:string; queryJson:string; bodyJson:string
  targetBy:'role'|'label'|'test_id'|'css'|'resource_id'|'text'|'description'; targetValue:string; targetName:string
  input:string; alwaysRun:boolean; assertions:EditableAssertion[]; x:string; y:string; button:string; clicks:string
  waitState:string; timeout:string
  apiParameters?:Record<string,unknown>
}
export const newAssertion=():EditableAssertion=>({id:crypto.randomUUID(),kind:'status_code',expected:'200',path:''})
export const newStep=():EditableStep=>({id:crypto.randomUUID(),intent:'',driver:'api',operation:'api.request',method:'GET',path:'/',
  queryJson:'',bodyJson:'',targetBy:'role',targetValue:'',targetName:'',input:'',alwaysRun:false,assertions:[newAssertion()],
  x:'',y:'',button:'left',clicks:'-3',waitState:'visible',timeout:'10000'})
export function switchDriver(step:EditableStep,driver:DriverKind):EditableStep {
  return {...newStep(),id:step.id,intent:step.intent,alwaysRun:step.alwaysRun,driver,assertions:[],
    operation:{api:'api.request',web:'web.open',android:'android.launch',desktop:'desktop.click'}[driver],
    targetBy:driver==='android'?'resource_id':'role'}
}
function objectJson(value:string):Record<string,unknown> {
  const parsed=JSON.parse(value)
  if (!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象')
  return parsed
}
function integer(value:string,label:string):number {
  if (!value.trim()||!Number.isInteger(Number(value))) throw new Error(`${label}必须是整数`)
  return Number(value)
}
function expected(item:EditableAssertion):unknown {
  if(item.kind==='status_code') return integer(item.expected,'状态码')
  if(item.kind==='element_visible') {
    if(!['true','false'].includes(item.expected)) throw new Error('可见性预期必须为 true 或 false')
    return item.expected==='true'
  }
  if(item.kind==='pixel_rgb_equals') {
    const rgb=JSON.parse(item.expected)
    if(!Array.isArray(rgb)||rgb.length!==3||rgb.some(x=>!Number.isInteger(x)||x<0||x>255)) throw new Error('RGB 必须为 0..255 的三个整数')
    return rgb
  }
  if(item.kind==='json_field_equals') {try{return JSON.parse(item.expected)}catch{return item.expected}}
  return item.expected
}
export function compileEditableStep(step:EditableStep,index:number):StepSpec {
  if(step.apiParameters)return {order:index+1,intent:step.intent.trim(),driver:'api',operation:'api.request',parameters:step.apiParameters,always_run:step.alwaysRun,
    assertions:step.assertions.map(a=>({kind:a.kind,expected:expected(a),...(a.kind==='json_field_equals'?{path:a.path}:{})}))}
  let parameters:Record<string,unknown>={}
  const op=step.operation
  if(step.driver==='api') parameters={method:step.method,path:step.path,
    ...(step.queryJson.trim()?{query:objectJson(step.queryJson)}:{}),...(step.bodyJson.trim()?{json:JSON.parse(step.bodyJson)}:{})}
  else if(step.driver==='desktop') {
    if(op==='desktop.write') parameters={text:step.input}
    else if(op==='desktop.hotkey') parameters={keys:step.input.split(',').map(x=>x.trim())}
    else parameters={x:integer(step.x,'X'),y:integer(step.y,'Y'),...(op==='desktop.click'?{button:step.button}:{}),
      ...(op==='desktop.scroll'?{clicks:integer(step.clicks,'滚轮格数')}:{})}
  } else if(step.driver==='android') {
    if(op==='android.swipe') parameters=objectJson(step.bodyJson)
    else parameters={...(step.targetValue.trim()&&['android.tap','android.input_text','android.inspect'].includes(op)?{target:{[step.targetBy]:step.targetValue}}:{}),
      ...(op==='android.input_text'?{text:step.input}:{})}
  } else if(op==='web.open') parameters={path:step.path}
  else parameters={target:step.targetBy==='role'?{role:step.targetValue,...(step.targetName?{name:step.targetName}:{})}:{[step.targetBy]:step.targetValue},
    ...(['web.fill','web.select'].includes(op)?{value:step.input}:{}),...(op==='web.press'?{key:step.input}:{}),
    ...(op==='web.wait'?{state:step.waitState,timeout_ms:integer(step.timeout,'等待超时')}:{})}
  return {order:index+1,intent:step.intent.trim(),driver:step.driver,operation:op,parameters,always_run:step.alwaysRun,
    assertions:step.assertions.map(a=>({kind:a.kind,expected:expected(a),...(a.kind==='json_field_equals'?{path:a.path}:{})}))}
}
export function editCompiledStep(step:StepSpec):EditableStep {
  const p=step.parameters,t=(p.target??{}) as Record<string,unknown>
  const targetBy=(['role','label','test_id','css','resource_id','text','description'].find(k=>k in t)??'role') as EditableStep['targetBy']
  return {...newStep(),id:crypto.randomUUID(),intent:step.intent,driver:step.driver,operation:step.operation,
    ...(step.driver==='api'&&(p.request_snapshot_id||p.request)?{apiParameters:p}:{}),
    method:String(p.method??'GET'),path:String(p.path??'/'),targetBy,targetValue:String(t[targetBy]??''),targetName:String(t.name??''),
    queryJson:p.query===undefined?'':JSON.stringify(p.query,null,2),bodyJson:step.operation==='android.swipe'?JSON.stringify(p):p.json===undefined?'':JSON.stringify(p.json,null,2),
    input:Array.isArray(p.keys)?p.keys.join(','):String(p.text??p.value??p.key??''),alwaysRun:step.always_run,
    x:String(p.x??''),y:String(p.y??''),button:String(p.button??'left'),clicks:String(p.clicks??'-3'),
    waitState:String(p.state??'visible'),timeout:String(p.timeout_ms??10000),
    assertions:step.assertions.map(a=>({id:crypto.randomUUID(),kind:a.kind,path:a.path??'',expected:typeof a.expected==='string'?a.expected:JSON.stringify(a.expected)}))}
}
