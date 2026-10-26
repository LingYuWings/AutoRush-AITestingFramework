import { ArrowRight, FileText, Play, Plus } from '../components/icons'
import type { CaseRecord, PlanRecord, RunRecord } from '../shared/api'
import type { LiveEvent, View } from '../app/types'
import { EmptyState, PageHeader, ResultBar, StatusBadge } from '../components/ui'
import { countStatuses, relative, shortId } from '../shared/format'

export default function Overview({ cases, plans, runs, events, onNavigate, onNewCase, onOpenRun }: {
  cases: CaseRecord[]
  plans: PlanRecord[]
  runs: RunRecord[]
  events: LiveEvent[]
  onNavigate: (view: View) => void
  onNewCase: () => void
  onOpenRun: (id: string) => void
}) {
  const approved = cases.filter(item => item.status === 'approved').length
  const ready = plans.filter(item => item.status === 'ready').length
  const passedRuns = runs.filter(item => item.status === 'passed').length
  const passRate = runs.length ? Math.round(passedRuns / runs.length * 100) : null
  const allCaseResults = runs.flatMap(run => run.cases)
  const caseCounts = countStatuses(allCaseResults)
  const recent = runs.slice(0, 6)

  const metrics = [
    { label: '用例', value: cases.length, sub: `${approved} 条已批准` },
    { label: '测试计划', value: plans.length, sub: `${ready} 个就绪` },
    { label: '执行批次', value: runs.length, sub: `${allCaseResults.length} 次用例执行` },
  ]
  const pipeline = [
    { label: '草稿用例', value: cases.length - approved, hint: '编写步骤与断言', view: 'cases' as View },
    { label: '已批准用例', value: approved, hint: '可编入计划', view: 'cases' as View },
    { label: '就绪计划', value: ready, hint: '环境已锁定', view: 'plans' as View },
    { label: '运行报告', value: runs.length, hint: 'JSON · HTML · JUnit', view: 'reports' as View },
  ]

  return <>
    <PageHeader
      title="工作台"
      actions={<>
        <button className="secondary-button" onClick={onNewCase}><Plus size={15} /> 新建用例</button>
        <button className="primary-button" onClick={() => onNavigate('plans')}><Play size={14} /> 运行计划</button>
      </>}
    />

    <section className="metric-strip">
      {metrics.map(item => <div key={item.label} className="metric">
        <span className="metric-label">{item.label}</span>
        <strong>{item.value}</strong>
        <small>{item.sub}</small>
      </div>)}
      <div className="metric">
        <span className="metric-label">批次通过率</span>
        <strong>{passRate === null ? '—' : <>{passRate}<em>%</em></>}</strong>
        {allCaseResults.length
          ? <div className="metric-bar"><ResultBar items={allCaseResults} size="sm" /><small>{caseCounts.passed} 通过 · {caseCounts.failed + caseCounts.error} 失败</small></div>
          : <small>暂无执行数据</small>}
      </div>
    </section>

    <div className="overview-grid">
      <section className="surface">
        <div className="surface-header">
          <div><h3>最近执行</h3></div>
          <button className="text-button" onClick={() => onNavigate('reports')}>全部报告 <ArrowRight size={14} /></button>
        </div>
        {recent.length ? <div className="run-list">
          {recent.map(run => {
            const plan = plans.find(item => item.id === run.plan_id)
            return <button key={run.id} className="run-row" onClick={() => onOpenRun(run.id)}>
              <span className={`run-status-dot dot-${run.status}`} />
              <span className="run-row-main">
                <strong>{plan?.name ?? '未知计划'}</strong>
                <span className="mono">#{shortId(run.id)} · {run.cases.length} 个用例 · {relative(run.created_at)}</span>
              </span>
              <ResultBar items={run.cases} />
              <StatusBadge status={run.status} />
            </button>
          })}
        </div> : <EmptyState icon={FileText} title="暂无执行记录" description="创建并运行测试计划后，结果会出现在这里。" />}
      </section>

      <div className="overview-side">
        <section className="surface">
          <div className="surface-header"><div><h3>流程概况</h3></div></div>
          <ol className="pipeline">
            {pipeline.map(stage => <li key={stage.label}>
              <button onClick={() => onNavigate(stage.view)}>
                <span className="pipeline-text"><strong>{stage.label}</strong><small>{stage.hint}</small></span>
                <span className="pipeline-value">{stage.value}</span>
              </button>
            </li>)}
          </ol>
        </section>

        <section className="surface">
          <div className="surface-header"><div><h3>实时事件</h3></div><span className="mono muted small">events/ws</span></div>
          {events.length ? <ul className="event-feed">
            {events.slice(0, 7).map(event => <li key={event.id}>
              <span className={`event-dot dot-${event.tone}`} />
              <span className="event-text">{event.text}</span>
              <time className="mono">{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
            </li>)}
          </ul> : <p className="quiet-note">暂无事件。运行计划时，进度会显示在这里。</p>}
        </section>
      </div>
    </div>
  </>
}
