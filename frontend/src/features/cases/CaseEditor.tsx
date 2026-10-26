import { useEffect, useState } from 'react'
import { CircleAlert, Plus, X } from '../../components/icons'
import { api, type CaseCompilePayload, type CaseCompileResult, type CaseRecord, type DriverKind, type ProviderConfig } from '../../shared/api'
import { newStep, switchDriver, editCompiledStep, compileEditableStep as compileStep, type EditableStep } from './step-form'
import StepCard from './StepCard'
import NaturalStepCard from './NaturalStepCard'
import {buildNaturalCase,newNaturalStep,type NaturalStep} from './natural-form'
import {platformOf} from './platform'
import './case-editor.css'
const EMPTY_PROVIDERS: ProviderConfig[] = []

export default function CaseEditor({ onCancel, onSave, providers = EMPTY_PROVIDERS, onCompile = api.compileCase, initial, initialPlatform='web' }: {
  onCancel: () => void
  onSave: (payload: Pick<CaseRecord, 'title' | 'description' | 'execution_mode' | 'platform' | 'steps' | 'postconditions'>) => Promise<void>
  initial?:CaseRecord
  initialPlatform?:DriverKind
  providers?: ProviderConfig[]
  onCompile?: (payload: CaseCompilePayload) => Promise<CaseCompileResult | null>
}) {
  const [platform,setPlatform]=useState<DriverKind|'mixed'>(initial?platformOf(initial):initialPlatform)
  const freshNatural=()=>({...newNaturalStep(),driver:platform==='mixed'?'web' as const:platform})
  const freshStructured=()=>switchDriver(newStep(),platform==='mixed'?'web':platform)
  const editNatural=(step:CaseRecord['steps'][number]):NaturalStep=>({id:crypto.randomUUID(),intent:step.intent,expected_result:step.expected_result??'',driver:step.driver,always_run:step.always_run})
  const [title,setTitle]=useState(initial?.title??'')
  const [description,setDescription]=useState(initial?.description??'')
  const [mode,setMode]=useState<'agent'|'structured'>(initial?.execution_mode??(initial?'structured':'agent'))
  const [naturalSteps,setNaturalSteps]=useState<NaturalStep[]>(initial?.execution_mode==='agent'?initial.steps.map(editNatural):[freshNatural()])
  const [naturalCleanup,setNaturalCleanup]=useState<NaturalStep[]>(initial?.execution_mode==='agent'?initial.postconditions.map(editNatural):[])
  const [steps,setSteps]=useState<EditableStep[]>(initial&&initial.execution_mode!=='agent'?initial.steps.map(editCompiledStep):[freshStructured()])
  const [cleanup,setCleanup]=useState<EditableStep[]>(initial&&initial.execution_mode!=='agent'?initial.postconditions.map(editCompiledStep):[])
  const [saving, setSaving] = useState(false)
  const [availableProviders, setAvailableProviders] = useState(providers)
  useEffect(() => {
    if (providers.length) setAvailableProviders(providers)
    else void api.providerConfigs().then(setAvailableProviders).catch(() => setAvailableProviders([]))
  }, [providers])
  const eligibleProviders = availableProviders.filter(item => item.capabilities.includes('structured_output') && ['openai_chat', 'openai_responses'].includes(item.protocol))
  const [providerId, setProviderId] = useState('')
  const selectedProviderId = eligibleProviders.some(item => item.id === providerId) ? providerId : eligibleProviders[0]?.id ?? ''
  const [compiling, setCompiling] = useState(false)
  const [compileWarnings, setCompileWarnings] = useState<string[]>([])
  const [editorError, setEditorError] = useState<string | null>(null)
  const replace = (items: EditableStep[], setter: (items: EditableStep[]) => void, value: EditableStep) => setter(items.map(item => item.id === value.id ? value : item))
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setEditorError(null)
    try { const payload=mode==='agent'?buildNaturalCase({title,description,steps:naturalSteps,postconditions:naturalCleanup}):{execution_mode:'structured' as const, title: title.trim(), description: description.trim(), steps: steps.map(compileStep), postconditions: cleanup.map(compileStep) }; await onSave({...payload,platform:platform==='mixed'?null:platform}) }
    catch (error) { setEditorError(error instanceof Error ? error.message : '保存失败') }
    finally { setSaving(false) }
  }
  const compile = async () => {
    if (!selectedProviderId) return
    setCompiling(true)
    try {
      const result = await onCompile({
        provider_config_id: selectedProviderId, title: title.trim(), description: description.trim(),
        steps: steps.map(step => ({ intent: step.intent.trim(), driver: step.driver as 'api' | 'web', always_run: step.alwaysRun })),
        postconditions: cleanup.map(step => ({ intent: step.intent.trim(), driver: step.driver as 'api' | 'web', always_run: step.alwaysRun })),
      })
      if (result) {
        setSteps(result.draft.steps.map(editCompiledStep))
        setCleanup(result.draft.postconditions.map(editCompiledStep))
        setCompileWarnings(result.warnings)
      }
    } catch (error) {
      setCompileWarnings([error instanceof Error ? error.message : '模型编译失败'])
    } finally { setCompiling(false) }
  }
  return <form className="editor-panel" onSubmit={submit}>
    <div className="editor-top"><div><h2>{initial?'编辑用例':'新建用例'}</h2><p className="muted">用自然语言描述步骤和预期，或选择高级结构化动作。保存草稿并批准后编入计划。</p></div><button type="button" className="icon-button" onClick={onCancel} aria-label="关闭"><X size={20} /></button></div>
    <div className="field-grid"><label className="field"><span>用例标题</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：管理后台健康检查" maxLength={200} required /></label><label className="field"><span>描述（可选）</span><input value={description} onChange={event => setDescription(event.target.value)} placeholder="本用例验证的业务场景" /></label></div>
    {initial?.status==='approved'&&<p className="quiet-note">已批准 v{initial.version} 保留，保存将生成 v{initial.version+1} 新草稿；已有计划继续使用原版本。</p>}
    <label className="field"><span>执行端</span><select value={platform} onChange={e=>{const value=e.target.value as DriverKind|'mixed';setPlatform(value);if(value!=='mixed'){setNaturalSteps(old=>old.map(step=>({...step,driver:value})));setNaturalCleanup(old=>old.map(step=>({...step,driver:value})));setSteps(old=>old.map(step=>switchDriver(step,value)));setCleanup(old=>old.map(step=>switchDriver(step,value)))}}}><option value="web">Web · Playwright</option><option value="android">Android · Portal</option><option value="desktop">Desktop · PyAutoGUI</option><option value="api">API 辅助</option>{initial&&platformOf(initial)==='mixed'&&<option value="mixed">历史混合（兼容原用例）</option>}</select></label>
    <label className="field"><span>执行方式</span><select value={mode} onChange={e=>{setMode(e.target.value as 'agent'|'structured');setSteps([freshStructured()]);setCleanup([]);setNaturalSteps([freshNatural()]);setNaturalCleanup([]);setCompileWarnings([]);setEditorError(null)}}><option value="agent">自然语言 · 模型观察并执行</option><option value="structured">高级 · 结构化动作</option></select></label>
    {mode==='agent'?<>
      <p className="quiet-note">填写操作意图和明确的预期结果。模型会读取实时页面或截图，每次选择一个动作，并核验预期；执行模型在测试计划中选择。</p>
      {editorError&&<p role="alert">{editorError}</p>}
      <div className="section-title"><h3>执行步骤</h3><button type="button" className="secondary-button" onClick={()=>setNaturalSteps([...naturalSteps,freshNatural()])}>添加步骤</button></div>
      {naturalSteps.map((step,index)=><NaturalStepCard key={step.id} step={step} index={index} lockDriver={platform!=='mixed'} onChange={value=>setNaturalSteps(naturalSteps.map(s=>s.id===value.id?value:s))} onRemove={()=>setNaturalSteps(naturalSteps.filter(s=>s.id!==step.id))}/>)}
      <div className="section-title"><h3>后处理</h3><button type="button" className="secondary-button" onClick={()=>setNaturalCleanup([...naturalCleanup,{...freshNatural(),always_run:true}])}>添加后处理</button></div>
      {naturalCleanup.map((step,index)=><NaturalStepCard key={step.id} step={step} index={index} lockDriver={platform!=='mixed'} cleanup onChange={value=>setNaturalCleanup(naturalCleanup.map(s=>s.id===value.id?value:s))} onRemove={()=>setNaturalCleanup(naturalCleanup.filter(s=>s.id!==step.id))}/>)}
      <div className="form-actions"><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={saving||!naturalSteps.length}>{saving?'保存中…':'保存草稿'}</button></div>
    </>:<>
    <div className="ai-compile-bar"><div><span><strong>模型辅助编译</strong><small>模型编译支持 API / Web。Android / Desktop 用例请手动填写结构化动作；所有结果需检查后保存。</small></span></div><label><span>模型配置</span><select value={selectedProviderId} onChange={event => setProviderId(event.target.value)} disabled={!eligibleProviders.length}>{eligibleProviders.length ? eligibleProviders.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model_id}</option>) : <option value="">请先在系统设置中配置模型</option>}</select></label><button type="button" className="secondary-button" onClick={() => void compile()} disabled={steps.concat(cleanup).some(step => ['android','desktop'].includes(step.driver)) || compiling || !selectedProviderId || !title.trim() || steps.some(step => !step.intent.trim())}>{compiling ? '编译中…' : '补全结构化动作'}</button></div>
    {compileWarnings.length > 0 && <div className="compile-warnings"><CircleAlert size={16} /><div><strong>编译提示</strong>{compileWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
    {editorError && <div role="alert" className="compile-warnings"><CircleAlert size={16} /><div>{editorError}</div></div>}
    <div className="section-title"><div><h3>执行步骤</h3><span>{steps.length} 个步骤</span></div><button type="button" className="secondary-button" onClick={() => setSteps([...steps, freshStructured()])}><Plus size={16} /> 添加步骤</button></div>
    <div className="steps-list">{steps.map((step, index) => <StepCard key={step.id} step={step} index={index} lockDriver={platform!=='mixed'} cleanup={false} onChange={value => replace(steps, setSteps, value)} onRemove={() => setSteps(steps.filter(item => item.id !== step.id))} />)}</div>
    <div className="section-title"><div><h3>后处理</h3><span>用于清理测试状态</span></div><button type="button" className="secondary-button" onClick={() => setCleanup([...cleanup, { ...freshStructured(), alwaysRun: true, assertions: [] }])}><Plus size={16} /> 添加后处理</button></div>
    <div className="steps-list">{cleanup.map((step, index) => <StepCard key={step.id} step={step} index={index} lockDriver={platform!=='mixed'} cleanup onChange={value => replace(cleanup, setCleanup, value)} onRemove={() => setCleanup(cleanup.filter(item => item.id !== step.id))} />)}</div>
    <div className="form-actions sticky-actions"><span className="muted">{steps.length} 个步骤 · {cleanup.length} 个后处理 · {steps.concat(cleanup).reduce((sum, step) => sum + step.assertions.length, 0)} 个断言</span><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" type="submit" disabled={saving || steps.length === 0}>{saving ? '保存中…' : '保存草稿'}</button></div>
    </>}
  </form>
}

