// Display live or archived model activity in a shared, filterable modal.
import { uiLanguage, uiText } from '../../shared/i18n.ts'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, X } from '../../components/icons'
import { api, ApiRequestError, type AgentLiveEntry, type AgentLiveOutput, type ModelOutputSource } from '../../shared/api'
import { statusLabel } from '../../shared/format'
import ModelOutputPreview from './ModelOutputPreview'
import { splitOutcome } from './model-output-format'

const labels = { model: uiText("模型状态"), output: uiText('模型原文'), reasoning: uiText("思考"), decision: uiText("决策"), execution: uiText("执行") }
const filters = ['all', 'output', 'reasoning', 'decision', 'execution', 'model'] as const
const clock = new Intl.DateTimeFormat(uiLanguage, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

type Group = { key: string; case: number | null; step: number | null; entries: AgentLiveEntry[] }

// Model replies and provider thinking are read in full; everything else is a one-line log entry.
const isCard = (entry: AgentLiveEntry) => entry.kind === 'output' || (entry.kind === 'reasoning' && entry.source === 'provider')

// Collect consecutive entries that share a case and step so the context is stated once.
function groupEntries(entries: AgentLiveEntry[]): Group[] {
  const groups: Group[] = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    if (last && last.case === entry.case && last.step === entry.step) last.entries.push(entry)
    else groups.push({ key: `${entry.id}`, case: entry.case, step: entry.step, entries: [entry] })
  }
  return groups
}

// Poll only while the dialog is open and keep its final snapshot available for review.
export default function AgentLiveDialog({ executionId, source = 'plan', initialFilter = 'all', onClose }: {
  executionId: string
  source?: ModelOutputSource
  initialFilter?: typeof filters[number]
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const titleId = useId()
  const [snapshot, setSnapshot] = useState<AgentLiveOutput | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<typeof filters[number]>(initialFilter)
  const [detached, setDetached] = useState(false)

  useLayoutEffect(() => {
    const panel = dialog.current
    panel?.showModal()
    return () => panel?.close()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    let firstSnapshot = true

    // Schedule the next read after the previous one finishes to avoid overlapping requests.
    async function poll() {
      try {
        const value = await api.agentLiveOutput(executionId, controller.signal, source)
        if (controller.signal.aborted) return
        if (firstSnapshot) {
          follow.current = value.active
          firstSnapshot = false
        }
        setSnapshot(value)
        setError('')
        if (value.active) timer = window.setTimeout(poll, 750)
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : uiText("无法读取实时输出"))
        if (!(cause instanceof ApiRequestError) || cause.status >= 500) timer = window.setTimeout(poll, 1800)
      }
    }
    void poll()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [executionId, source])

  useLayoutEffect(() => {
    const panel = scroll.current
    if (panel && follow.current) panel.scrollTop = panel.scrollHeight
  }, [snapshot, filter])

  // Return to the newest entry and resume following the live stream.
  const jumpToLatest = () => {
    const panel = scroll.current
    follow.current = true
    setDetached(false)
    if (panel) panel.scrollTop = panel.scrollHeight
  }

  const all = snapshot?.entries ?? []
  const counts = Object.fromEntries(filters.map(kind => [kind, kind === 'all' ? all.length : all.filter(entry => entry.kind === kind).length]))
  const entries = all.filter(entry => filter === 'all' || entry.kind === filter)
  const live = Boolean(snapshot?.active)
  return <dialog ref={dialog} className="plan-dialog agent-live-dialog" aria-labelledby={titleId} onKeyDown={event => {
    if (event.key === 'Escape') event.stopPropagation()
  }} onCancel={event => {
    event.preventDefault()
    onClose()
  }}>
    <div className="plan-form agent-live-layout">
      <header className="plan-dialog-header">
        <div><h2 id={titleId}>{source === 'report' ? uiText('模型输出') : uiText("实时模型输出")}</h2>
          <p className="agent-live-status">{live && <span className="live-dot" aria-hidden="true" />}{uiText("执行 #")}{executionId.slice(0, 8)} · {snapshot ? live ? uiText("实时更新") : uiText("执行已结束") : uiText("正在读取")}</p></div>
        <button type="button" className="icon-button" aria-label={uiText("关闭模型输出")} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="agent-live-toolbar">
        <div className="segmented agent-live-filters" role="group" aria-label={uiText("输出分类")}>
          {filters.map(kind => <button key={kind} type="button" className={filter === kind ? 'active' : ''} aria-pressed={filter === kind} onClick={() => {
            follow.current = snapshot?.active ?? true
            setDetached(false)
            if (!follow.current && scroll.current) scroll.current.scrollTop = 0
            setFilter(kind)
          }}>{kind === 'all' ? uiText("全部") : labels[kind]}<span aria-hidden="true">{snapshot ? counts[kind] : ''}</span></button>)}
        </div>
      </div>
      {error && <p className="inline-alert error plan-dialog-error" role="alert">{error}</p>}
      {snapshot?.from_trace && <p className="quiet-note plan-dialog-error">{uiText('此运行早于模型输出归档功能，以下内容来自已保存的决策轨迹。')}</p>}
      {snapshot?.truncated && <p className="quiet-note plan-dialog-error">{snapshot.active
        ? uiText('实时视图显示最新记录，运行结束后可查看保留的历史输出。')
        : uiText('记录超过保存上限，当前显示最后保留的条目。')}</p>}
      <div className="agent-live-viewport">
        <div className="plan-dialog-content agent-live-content" ref={scroll} onScroll={event => {
          const panel = event.currentTarget
          follow.current = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 32
          setDetached(live && !follow.current)
        }}>
          {entries.length ? <div className="agent-live-timeline">{groupEntries(entries).map(group => <section key={group.key} className="agent-live-group">
            <h3 className="agent-live-group-title">{groupTitle(group)}</h3>
            <ol className="agent-live-list">{group.entries.map(entry => isCard(entry)
              ? <LiveMessage key={entry.id} entry={entry} />
              : <LiveLine key={entry.id} entry={entry} />)}</ol>
          </section>)}</div>
            : <p className="quiet-note agent-live-empty">{snapshot && !snapshot.active && !snapshot.entries.length
              ? uiText('这次运行没有可查看的模型输出。')
              : filter === 'output' ? uiText('暂无模型原文。正文会在模型返回时显示。')
                : filter === 'reasoning' ? uiText("尚无思考内容。这里会显示模型服务提供的思考文本，以及模型随决策给出的简要依据。") : uiText("此分类暂时没有输出。")}</p>}
        </div>
        {live && detached && <button type="button" className="secondary-button agent-live-jump" onClick={jumpToLatest}><ChevronDown size={14} />{uiText('跳到最新')}</button>}
      </div>
    </div>
  </dialog>
}

// Name a group by its case and step, or as run-level activity before any case starts.
function groupTitle(group: Group): string {
  if (group.case === null) return uiText('运行')
  return group.step === null ? uiText('用例 {0}', group.case) : uiText('用例 {0} · 步骤 {1}', group.case, group.step)
}

// Render the entry time, or keep the column empty for entries restored from older traces.
function Time({ at }: { at: string | null }) {
  return at ? <time dateTime={at}>{clock.format(new Date(at))}</time> : <span />
}

// Render a model reply or provider thinking in full, with the formatted and original text.
function LiveMessage({ entry }: { entry: AgentLiveEntry }) {
  return <li className={`agent-live-message agent-live-${entry.kind}`}>
    <Time at={entry.at} />
    <div className="agent-live-card">
      <div className="agent-live-card-head"><strong>{labels[entry.kind]}</strong>
        {entry.clipped && <span className="agent-live-clipped">{uiText('文本已截断')}</span>}
      </div>
      <ModelOutputPreview text={entry.text} />
    </div>
  </li>
}

// Render status, decision and execution activity as a single log line with a coloured outcome.
function LiveLine({ entry }: { entry: AgentLiveEntry }) {
  const text = activityText(entry)
  const outcome = entry.kind === 'execution' ? splitOutcome(text) : null
  return <li className={`agent-live-line agent-live-${entry.kind}`}>
    <Time at={entry.at} />
    <span className="agent-live-kind">{labels[entry.kind]}</span>
    <p>{entry.kind === 'decision' ? <code>{text}</code>
      : outcome ? <><code>{outcome.action}</code><span className={`agent-live-outcome outcome-${outcome.status}`}>{statusLabel[outcome.status] ?? outcome.status}</span></>
        : text}</p>
  </li>
}

// Localize application-generated activity while preserving the model's own wording.
function activityText(entry: AgentLiveEntry): string {
  const text = entry.text
  if (entry.kind === 'reasoning') {
    const prefix = '决策依据 · '
    return entry.source === 'decision' && text.startsWith(prefix) ? uiText('决策依据 · {0}', text.slice(prefix.length)) : text
  }
  const attempt = /^等待模型输出 · 第 (\d+) 次请求$/.exec(text)
  if (attempt) return uiText('等待模型输出 · 第 {0} 次请求', attempt[1])
  const separator = text.indexOf(' · ')
  if (separator >= 0) {
    const label = uiText(text.slice(0, separator))
    return label + text.slice(separator)
  }
  const httpStatus = /^模型服务返回 HTTP (\d+)$/.exec(text)
  return httpStatus ? uiText('模型服务返回 HTTP {0}', httpStatus[1]) : uiText(text)
}
