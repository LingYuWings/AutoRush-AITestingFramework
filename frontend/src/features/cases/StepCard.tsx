import { Plus, Trash2, X } from '../../components/icons'
import type { AssertionKind, DriverKind } from '../../shared/api'
import { newAssertion, switchDriver, type EditableStep } from './step-form'

const actions:Record<DriverKind,[string,string][]>= {
  api:[['api.request','HTTP 请求']],
  web:[['web.open','打开页面'],['web.click','点击元素'],['web.fill','输入文本'],['web.inspect','检查元素'],['web.press','按键'],['web.select','选择下拉项'],['web.wait','等待元素']],
  android:[['android.launch','启动 App'],['android.inspect','检查界面'],['android.tap','点击元素'],['android.input_text','输入文本'],['android.swipe','滑动'],['android.back','返回']],
  desktop:[['desktop.click','点击坐标'],['desktop.write','输入 ASCII 文本'],['desktop.hotkey','快捷键'],['desktop.scroll','滚动'],['desktop.inspect_pixel','检查像素']],
}
const labels:Record<AssertionKind,string>={status_code:'状态码等于',json_field_equals:'JSON 字段等于',body_contains:'响应体包含',url_equals:'URL 等于',url_contains:'URL 包含',element_visible:'元素可见',text_contains:'元素文本包含',pixel_rgb_equals:'像素 RGB 等于',package_equals:'App 包名等于'}
export default function StepCard({step,index,cleanup,onChange,onRemove,lockDriver=false}:{step:EditableStep;index:number;cleanup:boolean;onChange:(step:EditableStep)=>void;onRemove:()=>void;lockDriver?:boolean}) {
  const update=(patch:Partial<EditableStep>)=>onChange({...step,...patch})
  const field=(label:string,value:string,onValue:(value:string)=>void,placeholder='',required=false)=><label className="field"><span>{label}</span><input value={value} onChange={e=>onValue(e.target.value)} placeholder={placeholder} required={required}/></label>
  const op=step.operation,desktop=step.driver==='desktop',android=step.driver==='android',web=step.driver==='web'
  const target=web&&op!=='web.open'||android&&['android.tap','android.input_text','android.inspect'].includes(op)
  const assertionKinds:AssertionKind[]=desktop?['pixel_rgb_equals']:android?['element_visible','text_contains','package_equals']:web?['url_equals','url_contains','element_visible','text_contains']:['status_code','json_field_equals','body_contains']
  const canAssert=desktop?op==='desktop.inspect_pixel':android?op==='android.inspect':true
  return <div className={`step-card step-driver-${step.driver}`}>
    <div className="step-heading"><span className="step-number">{cleanup?'C':''}{String(index+1).padStart(2,'0')}</span><strong>{cleanup?'后处理步骤':'执行步骤'}</strong><span className={`driver-chip driver-${step.driver}`}>{step.driver}</span><button type="button" className="icon-button danger" onClick={onRemove} aria-label="删除步骤"><Trash2 size={16}/></button></div>
    {field('操作意图',step.intent,v=>update({intent:v}),'描述此步骤的目的',true)}
    <div className="field-grid">
      <label className="field"><span>驱动</span><select disabled={lockDriver} value={step.driver} onChange={e=>onChange(switchDriver(step,e.target.value as DriverKind))}><option value="api">HTTP API</option><option value="web">Web · Playwright</option><option value="android">Android · Portal</option><option value="desktop">Desktop · PyAutoGUI</option></select></label>
      <label className="field"><span>动作</span><select value={op} onChange={e=>update({operation:e.target.value,assertions:[],input:e.target.value==='web.press'?'Enter':''})}>{actions[step.driver].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {step.driver==='api'&&<>
      <label className="field"><span>方法</span><select value={step.method} onChange={e=>update({method:e.target.value})}>{['GET','POST','PUT','PATCH','DELETE','HEAD'].map(m=><option key={m}>{m}</option>)}</select></label>
      {field('站内路径',step.path,v=>update({path:v}),'/health',true)}
      <div className="field-grid"><label className="field"><span>查询参数 JSON（可选）</span><textarea value={step.queryJson} onChange={e=>update({queryJson:e.target.value})}/></label><label className="field"><span>请求体 JSON（可选）</span><textarea value={step.bodyJson} onChange={e=>update({bodyJson:e.target.value})}/></label></div>
    </>}
    {op==='web.open'&&field('站内路径',step.path,v=>update({path:v}),'/demo',true)}
    {android&&['android.launch','android.back'].includes(op)&&<p className="muted">App 包名在测试计划中指定。</p>}
    {op==='android.swipe'&&<label className="field"><span>滑动参数 JSON</span><textarea required value={step.bodyJson} onChange={e=>update({bodyJson:e.target.value})} placeholder={'{"from_x":300,"from_y":800,"to_x":300,"to_y":200,"duration_ms":400}'}/></label>}
    {target&&<>
      <div className="field-grid"><label className="field"><span>定位方式</span><select value={step.targetBy} onChange={e=>update({targetBy:e.target.value as EditableStep['targetBy']})}>{(android?['resource_id','text','description']:['role','label','test_id','css']).map(k=><option key={k} value={k}>{k}</option>)}</select></label>{field('目标值',step.targetValue,v=>update({targetValue:v}),'定位值',op!=='android.inspect')}</div>
      {step.targetBy==='role'&&field('可访问名称（可选）',step.targetName,v=>update({targetName:v}))}
    </>}
    {desktop&&!['desktop.write','desktop.hotkey'].includes(op)&&<div className="field-grid">{field('窗口内 X',step.x,v=>update({x:v}),'相对客户区左侧像素',true)}{field('窗口内 Y',step.y,v=>update({y:v}),'相对客户区顶部像素',true)}</div>}
    {op==='desktop.click'&&<label className="field"><span>鼠标按键</span><select value={step.button} onChange={e=>update({button:e.target.value})}>{['left','middle','right'].map(k=><option key={k}>{k}</option>)}</select></label>}
    {op==='desktop.scroll'&&field('滚轮格数',step.clicks,v=>update({clicks:v}),'-20..20，负值向下',true)}
    {['web.fill','web.select','web.press','android.input_text','desktop.write','desktop.hotkey'].includes(op)&&field(op==='desktop.hotkey'?'按键组合（逗号分隔）':op==='web.press'?'按键':'输入内容',step.input,v=>update({input:v}),op==='desktop.hotkey'?'ctrl,a':op==='web.press'?'Enter / Tab / Escape / Control+A':'仅使用测试数据',!['web.fill','web.select','android.input_text'].includes(op))}
    {op==='web.wait'&&<div className="field-grid"><label className="field"><span>等待状态</span><select value={step.waitState} onChange={e=>update({waitState:e.target.value})}><option value="visible">可见</option><option value="hidden">隐藏</option></select></label>{field('超时毫秒',step.timeout,v=>update({timeout:v}),'100..15000',true)}</div>}
    {desktop&&<p className="quiet-note">操作指定 Windows 主屏窗口；输入支持 ASCII，请切换英文输入模式。鼠标移至主屏角落可停止。</p>}
    <div className="assertion-header"><span>逐步断言</span><button type="button" className="text-button" disabled={!canAssert} onClick={()=>update({assertions:[...step.assertions,{...newAssertion(),kind:assertionKinds[0],expected:desktop?'[0,0,0]':web?'':android?'true':'200'}]})}><Plus size={14}/> 添加断言</button></div>
    {step.assertions.map(a=><div className="assertion-row" key={a.id}>
      <select aria-label="断言类型" value={a.kind} onChange={e=>update({assertions:step.assertions.map(item=>item.id===a.id?{...item,kind:e.target.value as AssertionKind,expected:e.target.value==='element_visible'?'true':e.target.value==='pixel_rgb_equals'?'[0,0,0]':''}:item)})}>{assertionKinds.map(k=><option key={k} value={k}>{labels[k]}</option>)}</select>
      {a.kind==='json_field_equals'&&<input aria-label="JSON 路径" value={a.path} onChange={e=>update({assertions:step.assertions.map(i=>i.id===a.id?{...i,path:e.target.value}:i)})} placeholder="$.status"/>}
      <input aria-label="预期值" value={a.expected} onChange={e=>update({assertions:step.assertions.map(i=>i.id===a.id?{...i,expected:e.target.value}:i)})} placeholder={a.kind==='element_visible'?'true / false':a.kind==='pixel_rgb_equals'?'[255,0,0]':'预期值'} required/>
      <button type="button" className="icon-button" aria-label="删除断言" onClick={()=>update({assertions:step.assertions.filter(i=>i.id!==a.id)})}><X size={14}/></button>
    </div>)}
    {cleanup&&<label className="check-line"><input type="checkbox" checked={step.alwaysRun} onChange={e=>update({alwaysRun:e.target.checked})}/> 即使前序步骤失败也执行</label>}
  </div>
}
