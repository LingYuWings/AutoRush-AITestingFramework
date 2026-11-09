// Display a running plan's transient model activity in a filterable modal.
import { uiLanguage, uiText } from '../../shared/i18n.ts'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { X } from '../../components/icons'
import { api, ApiRequestError, type AgentLiveEntry, type AgentLiveOutput } from '../../shared/api'

const labels = { model: uiText("模型状态"), reasoning: uiText("思考"), decision: uiText("决策"), execution: uiText("执行") }
const filters = ['all', 'reasoning', 'decision', 'execution', 'model'] as const
const clock = new Intl.DateTimeFormat(uiLanguage, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Poll only while the dialog is open and keep its final snapshot available for review.
export default function AgentLiveDialog({ executionId, onClose }: { executionId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const titleId = useId()
  const [snapshot, setSnapshot] = useState<AgentLiveOutput | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<typeof filters[number]>('all')

  useLayoutEffect(() => {
    const panel = dialog.current
    panel?.showModal()
    return () => panel?.close()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined

    // Schedule the next read after the previous one finishes to avoid overlapping requests.
    async function poll() {
      try {
        const value = await api.agentLiveOutput(executionId, controller.signal)
        if (controller.signal.aborted) return
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
  }, [executionId])

  useLayoutEffect(() => {
    const panel = scroll.current
    if (panel && follow.current) panel.scrollTop = panel.scrollHeight
  }, [snapshot, filter])

  const entries = (snapshot?.entries ?? []).filter(entry => filter === 'all' || entry.kind === filter)
  return <dialog ref={dialog} className="plan-dialog agent-live-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault()
    onClose()
  }}>
    <div className="plan-form agent-live-layout">
      <header className="plan-dialog-header">
        <div><h2 id={titleId}>{uiText("实时模型输出")}</h2><p>{uiText("执行 #")}{executionId.slice(0, 8)} · {snapshot ? snapshot.active ? uiText("实时更新") : uiText("执行已结束") : uiText("正在读取")}</p></div>
        <button type="button" className="icon-button" aria-label={uiText("关闭实时输出")} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="agent-live-filters" role="group" aria-label={uiText("输出分类")}>
        {filters.map(kind => <button key={kind} type="button" className="secondary-button" aria-pressed={filter === kind} onClick={() => {
          follow.current = true
          setFilter(kind)
        }}>{kind === 'all' ? uiText("全部") : labels[kind]}</button>)}
      </div>
      {error && <p className="inline-alert error plan-dialog-error" role="alert">{error}</p>}
      <div className="plan-dialog-content agent-live-content" ref={scroll} onScroll={event => {
        const panel = event.currentTarget
        follow.current = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 32
      }}>
        {entries.length ? <ol className="agent-live-list">{entries.map(entry => <LiveMessage key={entry.id} entry={entry} />)}</ol>
          : <p className="quiet-note">{filter === 'reasoning' ? uiText("尚无思考内容。这里会显示模型服务提供的思考文本，以及模型随决策给出的简要依据。") : uiText("此分类暂时没有输出。")}</p>}
      </div>
    </div>
  </dialog>
}

// Render one activity message as plain text with its execution context.
function LiveMessage({ entry }: { entry: AgentLiveEntry }) {
  return <li className={`agent-live-message agent-live-${entry.kind}`}>
    <div><strong>{labels[entry.kind]}</strong>
      {entry.case !== null && <span>{uiText("用例 ")}{entry.case}{entry.step !== null ? uiText(" · 步骤 {0}", entry.step) : ''}</span>}
      <time dateTime={entry.at}>{clock.format(new Date(entry.at))}</time>
    </div>
    <p>{activityText(entry)}</p>
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
