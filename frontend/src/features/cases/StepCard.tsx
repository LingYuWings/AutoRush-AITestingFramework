import { uiText } from '../../shared/i18n.ts'
import { Plus, X } from '../../components/icons'
import type { AssertionKind, DriverKind } from '../../shared/api'
import { newAssertion, switchDriver, type EditableStep } from './step-form'
import StepHeading from './StepHeading'

const actions:Record<DriverKind,[string,string][]>= {
  api:[['api.request',uiText("HTTP 请求")]],
  web:[['web.open',uiText("打开页面")],['web.click',uiText("点击元素")],['web.fill',uiText("输入文本")],['web.inspect',uiText("检查元素")],['web.press',uiText("按键")],['web.select',uiText("选择下拉项")],['web.wait',uiText("等待元素")]],
  android:[['android.launch',uiText("启动 App")],['android.inspect',uiText("检查界面")],['android.tap',uiText("点击元素")],['android.input_text',uiText("输入文本")],['android.swipe',uiText("滑动")],['android.back',uiText("返回")]],
  desktop:[['desktop.click',uiText("点击坐标")],['desktop.write',uiText("输入 ASCII 文本")],['desktop.hotkey',uiText("快捷键")],['desktop.scroll',uiText("滚动")],['desktop.inspect_pixel',uiText("检查像素")]],
}
const labels:Record<AssertionKind,string>={status_code:uiText("状态码等于"),json_field_equals:uiText("JSON 字段等于"),body_contains:uiText("响应体包含"),url_equals:uiText("URL 等于"),url_contains:uiText("URL 包含"),element_visible:uiText("元素可见"),text_contains:uiText("元素文本包含"),pixel_rgb_equals:uiText("像素 RGB 等于"),package_equals:uiText("App 包名等于")}
// Edit a structured step with fields specific to its driver and operation.
export default function StepCard({step,index,cleanup,onChange,onRemove,onMoveUp,onMoveDown,lockDriver=false}:{step:EditableStep;index:number;cleanup:boolean;onChange:(step:EditableStep)=>void;onRemove:()=>void;onMoveUp?:()=>void;onMoveDown?:()=>void;lockDriver?:boolean}) {
  // Apply a partial edit while retaining the rest of the step.
  const update=(patch:Partial<EditableStep>)=>onChange({...step,...patch})
  // Render a labeled text input and forward its edited value.
  const field=(label:string,value:string,onValue:(value:string)=>void,placeholder='',required=false)=><label className="field"><span>{label}</span><input value={value} onChange={e=>onValue(e.target.value)} placeholder={placeholder} required={required}/></label>
  const op=step.operation,desktop=step.driver==='desktop',android=step.driver==='android',web=step.driver==='web'
  const target=web&&op!=='web.open'||android&&['android.tap','android.input_text','android.inspect'].includes(op)
  const assertionKinds:AssertionKind[]=desktop?['pixel_rgb_equals']:android?['element_visible','text_contains','package_equals']:web?['url_equals','url_contains','element_visible','text_contains']:['status_code','json_field_equals','body_contains']
  const canAssert=desktop?op==='desktop.inspect_pixel':android?op==='android.inspect':true
  return <div className={`step-card step-driver-${step.driver}`}>
    <StepHeading index={index} cleanup={cleanup} title={cleanup?uiText("后处理步骤"):uiText("执行步骤")} driver={step.driver} onMoveUp={onMoveUp} onMoveDown={onMoveDown} onRemove={onRemove}/>
    {field(uiText("操作意图"),step.intent,v=>update({intent:v}),uiText("描述此步骤的目的"),true)}
    <div className="field-grid">
      <label className="field"><span>{uiText("驱动")}</span><select disabled={lockDriver} value={step.driver} onChange={e=>onChange(switchDriver(step,e.target.value as DriverKind))}><option value="api">HTTP API</option><option value="web">Web · Playwright</option><option value="android">Android · Portal</option><option value="desktop">Desktop · PyAutoGUI</option></select></label>
      <label className="field"><span>{uiText("动作")}</span><select value={op} onChange={e=>update({operation:e.target.value,assertions:[],input:e.target.value==='web.press'?'Enter':''})}>{actions[step.driver].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {step.driver==='api'&&<>
      <label className="field"><span>{uiText("方法")}</span><select value={step.method} onChange={e=>update({method:e.target.value})}>{['GET','POST','PUT','PATCH','DELETE','HEAD'].map(m=><option key={m}>{m}</option>)}</select></label>
      {field(uiText("站内路径"),step.path,v=>update({path:v}),'/health',true)}
      <div className="field-grid"><label className="field"><span>{uiText("查询参数 JSON（可选）")}</span><textarea className="mono-input" value={step.queryJson} onChange={e=>update({queryJson:e.target.value})}/></label><label className="field"><span>{uiText("请求体 JSON（可选）")}</span><textarea className="mono-input" value={step.bodyJson} onChange={e=>update({bodyJson:e.target.value})}/></label></div>
    </>}
    {op==='web.open'&&field(uiText("站内路径"),step.path,v=>update({path:v}),'/demo',true)}
    {android&&['android.launch','android.back'].includes(op)&&<p className="quiet-note">{uiText("App 包名在测试计划中指定。")}</p>}
    {op==='android.swipe'&&<label className="field"><span>{uiText("滑动参数 JSON")}</span><textarea className="mono-input" required value={step.bodyJson} onChange={e=>update({bodyJson:e.target.value})} placeholder={'{"from_x":300,"from_y":800,"to_x":300,"to_y":200,"duration_ms":400}'}/></label>}
    {target&&<>
      <div className="field-grid"><label className="field"><span>{uiText("定位方式")}</span><select value={step.targetBy} onChange={e=>update({targetBy:e.target.value as EditableStep['targetBy']})}>{(android?['resource_id','text','description']:['role','label','test_id','css']).map(k=><option key={k} value={k}>{k}</option>)}</select></label>{field(uiText("目标值"),step.targetValue,v=>update({targetValue:v}),uiText("定位值"),op!=='android.inspect')}</div>
      {step.targetBy==='role'&&field(uiText("可访问名称（可选）"),step.targetName,v=>update({targetName:v}))}
    </>}
    {desktop&&!['desktop.write','desktop.hotkey'].includes(op)&&<div className="field-grid">{field(uiText("窗口内 X"),step.x,v=>update({x:v}),uiText("相对客户区左侧像素"),true)}{field(uiText("窗口内 Y"),step.y,v=>update({y:v}),uiText("相对客户区顶部像素"),true)}</div>}
    {op==='desktop.click'&&<label className="field"><span>{uiText("鼠标按键")}</span><select value={step.button} onChange={e=>update({button:e.target.value})}>{['left','middle','right'].map(k=><option key={k}>{k}</option>)}</select></label>}
    {op==='desktop.scroll'&&field(uiText("滚轮格数"),step.clicks,v=>update({clicks:v}),uiText("-20..20，负值向下"),true)}
    {['web.fill','web.select','web.press','android.input_text','desktop.write','desktop.hotkey'].includes(op)&&field(op==='desktop.hotkey'?uiText("按键组合（逗号分隔）"):op==='web.press'?uiText("按键"):uiText("输入内容"),step.input,v=>update({input:v}),op==='desktop.hotkey'?'ctrl,a':op==='web.press'?'Enter / Tab / Escape / Control+A':uiText("仅使用测试数据"),!['web.fill','web.select','android.input_text'].includes(op))}
    {op==='web.wait'&&<div className="field-grid"><label className="field"><span>{uiText("等待状态")}</span><select value={step.waitState} onChange={e=>update({waitState:e.target.value})}><option value="visible">{uiText("可见")}</option><option value="hidden">{uiText("隐藏")}</option></select></label>{field(uiText("超时毫秒"),step.timeout,v=>update({timeout:v}),'100..15000',true)}</div>}
    {desktop&&<p className="quiet-note">{uiText("操作指定 Windows 主屏窗口；输入支持 ASCII，请切换英文输入模式。鼠标移至主屏角落可停止。")}</p>}
    <div className="assertion-header"><span>{uiText("逐步断言")}</span><button type="button" className="text-button" disabled={!canAssert} onClick={()=>update({assertions:[...step.assertions,{...newAssertion(),kind:assertionKinds[0],expected:desktop?'[0,0,0]':web?'':android?'true':'200'}]})}><Plus size={14}/>{uiText(" 添加断言")}</button></div>
    {step.assertions.map(a=><div className="assertion-row" key={a.id}>
      <select aria-label={uiText("断言类型")} value={a.kind} onChange={e=>update({assertions:step.assertions.map(item=>item.id===a.id?{...item,kind:e.target.value as AssertionKind,expected:e.target.value==='element_visible'?'true':e.target.value==='pixel_rgb_equals'?'[0,0,0]':''}:item)})}>{assertionKinds.map(k=><option key={k} value={k}>{labels[k]}</option>)}</select>
      {a.kind==='json_field_equals'&&<input aria-label={uiText("JSON 路径")} value={a.path} onChange={e=>update({assertions:step.assertions.map(i=>i.id===a.id?{...i,path:e.target.value}:i)})} placeholder="$.status"/>}
      <input aria-label={uiText("预期值")} value={a.expected} onChange={e=>update({assertions:step.assertions.map(i=>i.id===a.id?{...i,expected:e.target.value}:i)})} placeholder={a.kind==='element_visible'?'true / false':a.kind==='pixel_rgb_equals'?'[255,0,0]':uiText("预期值")} required/>
      <button type="button" className="icon-button" aria-label={uiText("删除断言")} onClick={()=>update({assertions:step.assertions.filter(i=>i.id!==a.id)})}><X size={14}/></button>
    </div>)}
    {cleanup&&<label className="check-line"><input type="checkbox" checked={step.alwaysRun} onChange={e=>update({alwaysRun:e.target.checked})}/>{uiText("前序步骤失败后仍执行")}</label>}
  </div>
}
