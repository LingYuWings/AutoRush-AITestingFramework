import {useEffect,useMemo,useState} from 'react'
import {ArrowLeft,ChevronLeft,ChevronRight,Download,FileText,KeyRound} from '../components/icons'
import {api,type CaseRecord,type PlanRecord,type ResultStatus,type RunRecord} from '../shared/api'
import {EmptyState,ResultBar,StatusBadge} from '../components/ui'
import {countStatuses,date,resultOrder,shortId,statusLabel} from '../shared/format'
import StepScreenshot from '../components/StepScreenshot'
import AgentTrace from '../features/runs/AgentTrace'

type CaseResult=RunRecord['cases'][number]

function CaseSection({item,index,title,authEpoch,onlyIssues}:{item:CaseResult;index:number;title:string;authEpoch:number;onlyIssues:boolean}) {
  const steps=onlyIssues?item.steps.filter(step=>step.status!=='passed'):item.steps
  const issues=item.steps.filter(step=>step.status!=='passed').length
  return <section className={`report-case report-case-${item.status}`} id={`case-${index}`}>
    <header className="report-case-heading">
      <span className="report-case-index mono">{String(index+1).padStart(2,'0')}</span>
      <div><h3>{title}</h3><p>{item.steps.length} 个步骤{issues>0&&<> · <span className="text-fail">{issues} 个未通过</span></>}</p></div>
      <StatusBadge status={item.status}/>
    </header>
    {steps.length?<ol className="timeline">{steps.map((step,i)=><li className={`timeline-step step-${step.status}`} key={`${step.order}-${i}`}>
      <span className="timeline-node" aria-hidden="true"/>
      <div className="timeline-body">
        <div className="timeline-title"><span className="mono">{String(step.order).padStart(2,'0')}</span><strong>{step.intent}</strong><StatusBadge status={step.status}/></div>
        {step.detail&&<p className="timeline-detail">{step.detail}</p>}
        {step.assertions.length>0&&<ul className="timeline-assertions">{step.assertions.map((assertion,k)=><li key={k}>{assertion}</li>)}</ul>}
        {step.evidence&&<StepScreenshot key={authEpoch} evidence={step.evidence}/>}
        {step.evidence&&<AgentTrace evidence={step.evidence} authEpoch={authEpoch}/>}
        {step.evidence&&Object.keys(step.evidence).length>0&&<details className="raw-evidence"><summary>原始证据 JSON</summary><pre className="evidence-preview">{JSON.stringify(step.evidence,null,2)}</pre></details>}
      </div>
    </li>)}</ol>:<p className="quiet-note report-case-empty">所有步骤均已通过。</p>}
  </section>
}

export default function ReportPage({id,runs,plans,cases,loaded,onBack,onOpen,onDownload}:{
  id:string;runs:RunRecord[];plans:PlanRecord[];cases:CaseRecord[];loaded:boolean
  onBack:()=>void;onOpen:(id:string)=>void;onDownload:(id:string,format:'json'|'html'|'junit')=>Promise<void>
}) {
  const index=runs.findIndex(run=>run.id===id)
  const run=runs[index] as RunRecord|undefined
  const plan=plans.find(item=>item.id===run?.plan_id)
  const [authEpoch,setAuthEpoch]=useState(0)
  const [connecting,setConnecting]=useState(false)
  const [error,setError]=useState('')
  const issueSteps=run?run.cases.reduce((sum,item)=>sum+item.steps.filter(step=>step.status!=='passed').length,0):0
  const [onlyIssues,setOnlyIssues]=useState(false)
  const counts=useMemo(()=>countStatuses(run?.cases??[]),[run])
  const stepTotal=run?run.cases.reduce((sum,item)=>sum+item.steps.length,0):0
  const caseTitle=(item:CaseResult)=>item.title||cases.find(testCase=>testCase.id===item.case_id)?.title||shortId(item.case_id)
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||(event.target as HTMLElement).closest('input,textarea,select,[contenteditable]'))return
      onBack()
    }
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)
  },[onBack])
  const connect=async()=>{setConnecting(true);setError('');try{api.setOperatorToken((await api.operatorSession()).operator_token);setAuthEpoch(v=>v+1)}catch(cause){setError(cause instanceof Error?cause.message:'本地连接失败')}finally{setConnecting(false)}}

  const back=<button className="back-link" onClick={onBack}><ArrowLeft size={15}/>运行报告</button>
  if(!run) return <div className="report-page">{back}<section className="surface">{loaded
    ?<EmptyState icon={FileText} title="找不到这份报告" description={`批次 #${shortId(id)} 不存在或已被清理。`}/>
    :<div className="page-loading" aria-busy="true"/>}</section></div>

  const passRate=run.cases.length?Math.round(counts.passed/run.cases.length*100):0
  const newer=runs[index-1],older=runs[index+1]
  return <div className="report-page">
    <div className="report-nav">
      {back}
      <div className="report-pager">
        <button className="icon-button" disabled={!newer} onClick={()=>newer&&onOpen(newer.id)} aria-label="较新的报告" title="较新的报告"><ChevronLeft size={16}/></button>
        <span className="num">{index+1} / {runs.length}</span>
        <button className="icon-button" disabled={!older} onClick={()=>older&&onOpen(older.id)} aria-label="较早的报告" title="较早的报告"><ChevronRight size={16}/></button>
      </div>
    </div>

    <header className={`report-hero hero-${run.status}`}>
      <div className="report-hero-main">
        <p className="eyebrow mono">#{shortId(run.id)} · {date(run.created_at)}{plan&&<> · {plan.environment}</>}</p>
        <h1>{plan?.name??'测试运行'}</h1>
        <div className="report-hero-actions">
          <div className="report-downloads">{(['json','html','junit'] as const).map(format=><button key={format} className="download-chip" onClick={()=>void onDownload(run.id,format)}><Download size={12}/>{format.toUpperCase()}</button>)}</div>
          <button className="text-button" disabled={connecting} onClick={()=>void connect()}><KeyRound size={13}/>{connecting?'连接中…':authEpoch?'已连接本地执行':'连接本地执行以查看截图'}</button>
        </div>
      </div>
      <div className="report-score">
        <span className="report-score-label">用例通过率</span>
        <strong className="num">{passRate}<em>%</em></strong>
        <StatusBadge status={run.status}/>
      </div>
    </header>

    <section className="report-stats" aria-label="结果统计">
      <ResultBar items={run.cases}/>
      <dl>
        <div><dt>用例</dt><dd className="num">{run.cases.length}</dd></div>
        <div><dt>步骤</dt><dd className="num">{stepTotal}</dd></div>
        {resultOrder.map(key=><div key={key} className={`stat-${key}${counts[key]?'':' is-zero'}`}><dt>{statusLabel[key]}</dt><dd className="num">{counts[key]}</dd></div>)}
      </dl>
    </section>

    {error&&<p role="alert" className="inline-alert error page-alert">{error}</p>}
    {run.termination_reason&&<p role="status" className="inline-alert page-alert">结束原因：{run.termination_reason}</p>}

    <div className={run.cases.length>1?'report-body has-index':'report-body'}>
      {run.cases.length>1&&<nav className="report-index" aria-label="用例目录">
        <p>用例目录</p>
        {run.cases.map((item,i)=><a key={item.case_id+i} href={`#case-${i}`} onClick={event=>{event.preventDefault();document.getElementById(`case-${i}`)?.scrollIntoView({behavior:'smooth',block:'start'})}}>
          <span className={`run-status-dot dot-${item.status as ResultStatus}`}/><span>{caseTitle(item)}</span>
        </a>)}
      </nav>}
      <div className="report-cases">
        {issueSteps>0&&<label className="check-line report-filter"><input type="checkbox" checked={onlyIssues} onChange={event=>setOnlyIssues(event.target.checked)}/>只看未通过的步骤（{issueSteps}）</label>}
        {run.cases.map((item,i)=><CaseSection key={item.case_id+i} item={item} index={i} title={caseTitle(item)} authEpoch={authEpoch} onlyIssues={onlyIssues}/>)}
      </div>
    </div>
  </div>
}
