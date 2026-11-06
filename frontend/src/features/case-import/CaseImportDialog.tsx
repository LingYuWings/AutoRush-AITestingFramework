import {useEffect,useMemo,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {Check,Download,FileText,RefreshCw,X} from '../../components/icons'
import {DriverChip} from '../../components/ui'
import {ApiRequestError,type DriverKind} from '../../shared/api'
import {importClient,importSessionId,rememberedImport} from './client'
import {applyValidation,changePlatform,editEntry,initialEntries,makeCommit,readDraft,recoverEntries} from './import-form'
import type {ImportCommit,ImportDraft,ImportEntry,ImportOptions,ImportResult,ImportSession,ImportSource} from './types'
import './case-import.css'

// Format available spreadsheet, topic, and line information for a candidate.
function sourceLabel(source:ImportSource):string{
  return [source.sheet_title,source.topic_path.join(' / '),source.line_start?`第 ${source.line_start} 行`:''].filter(Boolean).join(' · ')
}

// Guide users from source upload through review and draft creation.
export default function CaseImportDialog({onClose,onCreated,onOpenCase}:{onClose:()=>void;onCreated:()=>Promise<void>;onOpenCase:(id:string)=>void}){
  const session=useMemo(importSessionId,[])
  const [file,setFile]=useState<File|null>(null),[options,setOptions]=useState<ImportOptions>({default_platform:null,case_heading_level:2,case_depth:null,sheet_ids:null})
  const [value,setValue]=useState<ImportSession|null>(null),[entries,setEntries]=useState<ImportEntry[]>([]),[active,setActive]=useState(0)
  const [result,setResult]=useState<ImportResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[pending,setPending]=useState(false),[allowDuplicate,setAllowDuplicate]=useState(false)
  const frozen=useRef<ImportCommit|null>(null),controller=useRef<AbortController|null>(null),locked=useRef(false),mounted=useRef(true),panel=useRef<HTMLDivElement>(null)
  const current=entries[active],chosen=entries.filter(entry=>entry.selected)
  let draft:ImportDraft|null=null;try{if(current)draft=readDraft(current.text)}catch{/* JSON editor remains usable. */}
  const unavailable=Boolean(busy)||pending
  useEffect(()=>{
    mounted.current=true
    const previous=document.activeElement as HTMLElement|null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return()=>{mounted.current=false;controller.current?.abort();previous?.focus()}
  },[])
  // Replace the current preview and rebuild its editable candidate entries.
  const load=(next:ImportSession)=>{
    setValue(next);setEntries(initialEntries(next.preview?.candidates??[]));setActive(0);setResult(next.result)
    setAllowDuplicate(false);frozen.current=null;setPending(false);rememberedImport(next.import_id)
  }
  // Run one cancellable import operation at a time.
  const work=async(label:string,task:(signal:AbortSignal)=>Promise<void>)=>{
    if(locked.current)return
    locked.current=true;setBusy(label);setError('')
    controller.current=new AbortController()
    try{await task(controller.current.signal)}catch(cause){if(mounted.current&&!(cause instanceof Error&&cause.name==='AbortError'))setError(cause instanceof Error?cause.message:'导入操作失败')}
    finally{locked.current=false;if(mounted.current)setBusy('')}
  }
  // Clear the preview, candidate selection, and prior import outcome.
  const reset=()=>{setValue(null);setEntries([]);setResult(null);setError('');setActive(0)}
  // Apply import options and invalidate the existing preview.
  const updateOptions=(next:ImportOptions)=>{setOptions(next);reset()}
  // Apply a structured edit to the selected candidate and mark it for validation.
  const patch=(change:(old:ImportDraft)=>ImportDraft)=>{
    if(!current||!draft)return
    const text=JSON.stringify(change(draft),null,2)
    setEntries(old=>old.map((entry,index)=>index===active?editEntry(entry,text):entry))
  }
  // Send the selected candidate to the server for validation.
  const check=()=>void work('正在校验',async signal=>{
    if(!current||!value)return
    const payload:ImportCommit={session_id:session,idempotency_key:crypto.randomUUID(),allow_duplicate_file:allowDuplicate,
      selections:[{candidate_id:current.original.candidate_id,draft:readDraft(current.text),acknowledge_source_issues:current.reviewed}]}
    const checked=await importClient.validate(value.import_id,payload,signal)
    if(mounted.current)setEntries(old=>old.map(entry=>entry.original.candidate_id===current.original.candidate_id?applyValidation(entry,checked.candidates[0]):entry))
  })
  // Commit the selected candidates using the same payload on a retry.
  const submit=()=>void work('正在创建草稿',async signal=>{
    if(!value)return
    const payload=frozen.current??makeCommit(entries,session,crypto.randomUUID(),allowDuplicate)
    frozen.current=payload;setPending(true)
    let completed:ImportResult
    try{completed=await importClient.commit(value.import_id,payload,signal)}catch(cause){
      if(cause instanceof ApiRequestError&&cause.status>=400&&cause.status<500){frozen.current=null;setPending(false)}
      throw cause
    }
    if(!mounted.current)return
    setResult(completed);frozen.current=null;setPending(false)
    try{await onCreated()}catch{if(mounted.current)setError('草稿已创建，但列表刷新失败。请刷新页面查看，勿重复导入。')}
  })
  // Look up a previous import when its submission outcome is uncertain.
  const recover=()=>void work('正在查询结果',async signal=>{
    const id=value?.import_id??rememberedImport()
    if(!id)throw new Error('没有可恢复的导入记录')
    const next=await importClient.get(id,session,signal)
    if(!mounted.current)return
    if(next.result){load(next);await onCreated()}
    else if(!pending){
      setEntries(old=>recoverEntries(value?.import_id,next.import_id,next.preview?.candidates??[],old))
      setValue(next)
      if(value?.import_id!==next.import_id){setActive(0);setAllowDuplicate(false);rememberedImport(next.import_id)}
    }
    else setError('尚未查到提交结果，可使用原内容重试。重试不会重复创建草稿。')
  })
  // Check for pending work and unvalidated edits before closing the dialog.
  const close=()=>{
    if(busy)return
    if(!result&&entries.some(entry=>entry.dirty)&&!window.confirm('关闭会丢弃本次导入的未校验修改，确认关闭？'))return
    onClose()
  }
  // Support Escape dismissal and keep keyboard focus inside the dialog.
  const keyDown=(event:React.KeyboardEvent)=>{
    if(event.key==='Escape'){event.preventDefault();close()}
    if(event.key==='Tab'){
      const controls=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')??[]).filter(el=>el.getClientRects().length)
      const first=controls[0],last=controls[controls.length-1]
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
    }
  }
  return createPortal(<div className="case-import-overlay"><div className="case-import-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="case-import-title" onKeyDown={keyDown}>
    <header className="case-import-heading"><div className="case-import-heading-main"><span className="case-import-heading-icon"><FileText size={20}/></span><div><h2 id="case-import-title">导入用例</h2><p>选择文件、核对预览后创建草稿。文件不会自动执行。</p></div></div><button className="icon-button" aria-label="关闭导入" disabled={Boolean(busy)} onClick={close}><X size={18}/></button></header>
    <div className="case-import-content">
      <section className="case-import-config" aria-label="文件与映射">
        <label className="field case-import-file-field"><span>用例文件</span><input aria-label="用例文件" type="file" accept=".md,.markdown,.xmind" disabled={unavailable} onChange={event=>{setFile(event.target.files?.[0]??null);reset()}}/></label>
        <label className="field case-import-platform-field"><span>默认执行端</span><select aria-label="导入默认执行端" disabled={unavailable} value={options.default_platform??''} onChange={event=>updateOptions({...options,default_platform:event.target.value as DriverKind||null})}><option value="">按文件声明</option>{['web','android','desktop','api'].map(platform=><option key={platform} value={platform}>{platform}</option>)}</select></label>
        <label className="field"><span>Markdown 标题级别</span><select aria-label="Markdown 用例标题级别" disabled={unavailable} value={options.case_heading_level} onChange={event=>updateOptions({...options,case_heading_level:Number(event.target.value)})}>{[1,2,3,4,5].map(level=><option key={level} value={level}>H{level}</option>)}</select></label>
        <label className="field"><span>XMind 主题深度</span><input aria-label="XMind 用例主题深度" type="number" min={0} max={63} placeholder="自动识别用例标记" disabled={unavailable} value={options.case_depth??''} onChange={event=>updateOptions({...options,case_depth:event.target.value===''?null:Number(event.target.value)})}/></label>
        <label className="field case-import-sheets-field"><span>XMind 工作表 ID</span><input aria-label="XMind 工作表 ID" placeholder="留空导入全部，多个 ID 以逗号分隔" disabled={unavailable} value={options.sheet_ids?.join(',')??''} onChange={event=>updateOptions({...options,sheet_ids:event.target.value.trim()?event.target.value.split(',').map(id=>id.trim()).filter(Boolean):null})}/></label>
        <div className="case-import-actions"><button className="primary-button" disabled={!file||unavailable} onClick={()=>void work('正在解析文件',async signal=>{
          if(!file)return;if(file.size>10*1024*1024)throw new Error('文件不能超过 10 MiB')
          const next=await importClient.preview(file,options,session,signal);if(mounted.current)load(next)
        })}><FileText size={14}/>解析预览</button><button className="secondary-button" disabled={Boolean(busy)} onClick={()=>void work('正在下载模板',()=>importClient.template())}><Download size={14}/>下载 Markdown 模板</button><button className="text-button" disabled={Boolean(busy)} onClick={recover}><RefreshCw size={13}/>恢复上次预览／查询结果</button></div>
        <p className="quiet-note">UTF-8 Markdown 或 XMind；最多 10 MiB、500 条候选。执行地址、模型及设备仍在测试计划或单用例调试中配置。</p>
      </section>
      {error&&<p role="alert" className="case-import-error">{error}</p>}
      {busy&&<p role="status" className="case-import-progress"><RefreshCw size={14} className="spinning"/>{busy}…</p>}
      {result?<section className="case-import-result" aria-label="导入结果"><h3>已创建 {result.count} 条草稿</h3><p>可从用例管理继续编辑、批准，或运行单用例调试。</p>{result.case_ids.map((id,index)=><button className="secondary-button" key={id} onClick={()=>onOpenCase(id)}>查看用例 {index+1}</button>)}</section>:value?.preview&&<>
        <div className="case-import-summary"><strong><FileText size={15}/>{value.preview.filename}</strong><span>共 {entries.length} 条 · 已选择 {chosen.length} 条 · 待修复 {entries.filter(entry=>!entry.valid||entry.dirty).length} 条</span><span className="case-import-expiry mono">预览到期 {value.expires_at?new Date(value.expires_at*1000).toLocaleTimeString():''}</span></div>
        {value.preview.diagnostics.map((issue,index)=><p key={index} className="case-import-warning">{issue.message}</p>)}
        {value.duplicate_file&&<label className="case-import-warning"><input type="checkbox" checked={allowDuplicate} disabled={unavailable} onChange={event=>setAllowDuplicate(event.target.checked)}/>该文件已导入过，允许再次创建副本（不会覆盖原用例）</label>}
        {entries.length>0&&<div className="case-import-preview">
          <aside aria-label="导入候选列表"><button className="text-button" disabled={unavailable} onClick={()=>setEntries(old=>old.map(entry=>({...entry,selected:entry.valid&&!entry.dirty})))}>选择全部有效用例</button>{entries.map((entry,index)=><div key={entry.original.candidate_id} className={index===active?'case-import-candidate active':'case-import-candidate'}>
            <input type="checkbox" aria-label={`选择候选 ${index+1}`} checked={entry.selected} disabled={unavailable} onChange={event=>setEntries(old=>old.map((row,at)=>at===index?{...row,selected:event.target.checked}:row))}/>
            <button disabled={unavailable} aria-pressed={index===active} className="case-import-candidate-button" onClick={()=>setActive(index)}><strong>{index+1}. {entry.original.draft.title||'未命名用例'}</strong><span className={entry.dirty||!entry.valid?'case-import-state pending':'case-import-state ready'}>{entry.dirty?'修改待校验':entry.valid?'可导入':'需修复'} · {entry.original.draft.platform??'未选择执行端'}</span></button>
          </div>)}</aside>
          {current&&<section className="case-import-editor" aria-label="候选用例编辑"><p className="case-import-source mono">来源：{sourceLabel(current.original.source)}</p>
            {!draft&&<p role="alert" className="case-import-error">JSON 内容或字段类型无效，请在完整用例 JSON 中修正后重新校验。</p>}
            {current.diagnostics.map((issue,index)=><p key={index} className={issue.severity==='error'?'case-import-error':'case-import-warning'}>{issue.message}{issue.field&&`（${issue.field}）`}{issue.source?.line_start&&` · 第 ${issue.source.line_start} 行`}</p>)}
            {draft&&<><div className="field-grid case-import-identity"><label className="field"><span>用例标题</span><input aria-label="导入用例标题" disabled={unavailable} value={draft.title} onChange={event=>patch(old=>({...old,title:event.target.value}))}/></label><label className="field"><span>执行端</span><select aria-label="候选执行端" disabled={unavailable} value={draft.platform??''} onChange={event=>patch(old=>changePlatform(old,event.target.value as DriverKind))}><option value="" disabled>请选择</option>{['web','android','desktop','api'].map(platform=><option key={platform} value={platform}>{platform}</option>)}</select></label></div><label className="field"><span>说明与前置条件</span><textarea aria-label="导入用例说明" disabled={unavailable} rows={3} value={draft.description} onChange={event=>patch(old=>({...old,description:event.target.value}))}/></label>
              {(['steps','postconditions'] as const).map(section=>draft[section].map((step,index)=><fieldset className="step-card case-import-step" key={`${section}-${index}`}><legend><span className="step-number">{String(index+1).padStart(2,'0')}</span>{section==='steps'?'执行步骤':'后置步骤'}{step.driver?<DriverChip driver={step.driver}/>:<span className="muted">待选择执行端</span>}</legend><label className="field"><span>操作意图</span><textarea aria-label={`${section==='steps'?'步骤':'后置步骤'} ${index+1} 操作`} disabled={unavailable} rows={2} value={step.intent} onChange={event=>patch(old=>({...old,[section]:old[section].map((row,at)=>at===index?{...row,intent:event.target.value}:row)}))}/></label><label className="field"><span>预期结果</span><textarea aria-label={`${section==='steps'?'步骤':'后置步骤'} ${index+1} 预期`} disabled={unavailable} rows={2} value={step.expected_result??''} onChange={event=>patch(old=>({...old,[section]:old[section].map((row,at)=>at===index?{...row,expected_result:event.target.value}:row)}))}/></label></fieldset>))}
            </>}
            <details className="case-import-advanced"><summary>完整用例 JSON（可补充 API 请求或调整步骤）</summary><label className="field"><textarea className="case-import-json" aria-label="导入用例 JSON" rows={14} spellCheck={false} disabled={unavailable} value={current.text} onChange={event=>setEntries(old=>old.map((entry,index)=>index===active?editEntry(entry,event.target.value):entry))}/></label></details>
            {current.original.diagnostics.some(issue=>issue.severity==='error')&&<label className="case-import-review"><input type="checkbox" checked={current.reviewed} disabled={unavailable} onChange={event=>setEntries(old=>old.map((entry,index)=>index===active?{...entry,reviewed:event.target.checked,dirty:true,valid:false}:entry))}/>已核对原文中未映射或歧义的内容，确认以当前编辑内容为准</label>}
            <div className="case-import-validation"><button className="secondary-button" disabled={unavailable} onClick={check}><Check size={14}/>校验当前用例</button><span className="quiet-note">{current.dirty?'内容已修改，请重新校验':current.valid?'校验通过，可加入本次导入':'补齐内容后重新校验'}</span></div>
          </section>}
        </div>}
      </>}
    </div>
    <footer className="case-import-footer"><span>{pending?'提交结果未确认，请查询或使用原内容重试。':result?'导入完成':'确认后仅创建草稿，同名用例不会被覆盖。'}</span><button className="secondary-button" disabled={Boolean(busy)} onClick={close}>{result?'关闭':'取消'}</button>{!result&&value?.preview&&<button className="primary-button" disabled={Boolean(busy)||(!pending&&(!chosen.length||chosen.some(entry=>!entry.valid||entry.dirty)||(value.duplicate_file&&!allowDuplicate)))} onClick={submit}>{pending?'使用原内容重试':`创建 ${chosen.length} 条草稿`}</button>}</footer>
  </div></div>,document.body)
}
