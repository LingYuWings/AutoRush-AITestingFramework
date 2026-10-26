import {useLayoutEffect,useMemo,useState} from 'react'
import {ChevronRight,Download,FileText,Search} from '../components/icons'
import type {PlanRecord,RunRecord} from '../shared/api'
import {EmptyState,PageHeader,Pagination,ResultBar,StatusBadge,usePaged} from '../components/ui'
import {countStatuses,date,relative,resultOrder,shortId,statusLabel} from '../shared/format'
import {filterReports} from '../features/runs/report-search'
import {scroller} from '../shared/scroll'
import {routeHash} from '../app/router'

type StatusFilter='all'|'passed'|'failed'
// Survives unmounting so returning from a report lands on the same search, page and scroll offset.
const memory={query:'',status:'all' as StatusFilter,page:1,scroll:0}

export default function Reports({runs,plans,onOpen,onDownload}:{runs:RunRecord[];plans:PlanRecord[];onOpen:(id:string)=>void;onDownload:(id:string,format:'json'|'html'|'junit')=>Promise<void>}) {
  const [query,setQuery]=useState(memory.query)
  const [status,setStatus]=useState<StatusFilter>(memory.status)
  const filtered=useMemo(()=>filterReports(runs,plans,query).filter(run=>status==='all'||(status==='passed'?run.status==='passed':run.status!=='passed')),[runs,plans,query,status])
  const paged=usePaged(filtered,`${query}|${status}`,20,memory.page)
  const planName=useMemo(()=>new Map(plans.map(plan=>[plan.id,plan.name])),[plans])
  const failing=runs.filter(run=>run.status!=='passed').length
  useLayoutEffect(()=>{ if(memory.scroll) scroller()?.scrollTo({top:memory.scroll}) },[])
  const open=(id:string)=>{Object.assign(memory,{query,status,page:paged.page,scroll:scroller()?.scrollTop??0});onOpen(id)}
  const filters:{key:StatusFilter;label:string;count:number}[]=[{key:'all',label:'全部',count:runs.length},{key:'passed',label:'通过',count:runs.length-failing},{key:'failed',label:'未通过',count:failing}]

  return <>
    <PageHeader title="运行报告" description="每个批次都有独立的报告页，包含用例结果、逐步证据与模型决策轨迹。"/>
    <section className="surface table-surface report-list">
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="按结果筛选">{filters.map(item=><button key={item.key} role="tab" aria-selected={status===item.key} className={status===item.key?'active':''} onClick={()=>setStatus(item.key)}>{item.label}<span>{item.count}</span></button>)}</div>
        <label className="search-field"><Search size={15}/><input aria-label="搜索运行报告" placeholder="搜索批次、计划、用例、结果…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      </div>
      {paged.items.map(run=>{
        const counts=countStatuses(run.cases)
        const summary=resultOrder.filter(key=>counts[key]).map(key=>`${counts[key]} ${statusLabel[key]}`).join(' · ')
        return <article className={`report-row report-row-${run.status}`} key={run.id}>
          <a className="report-row-link" href={routeHash({view:'reports',id:run.id})} onClick={event=>{if(event.metaKey||event.ctrlKey||event.shiftKey)return;event.preventDefault();open(run.id)}}>
            <span className={`run-status-dot dot-${run.status}`}/>
            <span className="report-row-main">
              <strong>{planName.get(run.plan_id)??'测试运行'}</strong>
              <span className="row-id">#{shortId(run.id)} · <time dateTime={run.created_at} title={date(run.created_at)}>{relative(run.created_at)}</time> · {run.cases.length} 个用例{summary&&<> · {summary}</>}</span>
            </span>
            <ResultBar items={run.cases} size="sm"/>
            <StatusBadge status={run.status}/>
          </a>
          <div className="report-downloads">{(['json','html','junit'] as const).map(format=><button key={format} className="download-chip" title={`下载 ${format.toUpperCase()} 报告`} onClick={()=>void onDownload(run.id,format)}><Download size={12}/>{format.toUpperCase()}</button>)}</div>
          <ChevronRight size={16} className="report-row-chevron" aria-hidden="true"/>
        </article>
      })}
      {!filtered.length&&<EmptyState icon={FileText} title={runs.length?'没有匹配的报告':'还没有报告'} description={runs.length?'调整搜索词或筛选条件后重试。':'运行计划后报告会显示在这里。'}/>}
      <Pagination {...paged}/>
    </section>
  </>
}
