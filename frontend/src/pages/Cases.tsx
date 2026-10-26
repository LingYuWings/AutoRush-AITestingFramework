import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, Check, ClipboardList, Pencil, Plus, Search, Trash2, Undo2 } from '../components/icons'
import type { CaseRecord, DriverKind, StepSpec } from '../shared/api'
import { filterCases, platformLabels, platformOf, type CasePlatform } from '../features/cases/platform'
import { DriverChip, EmptyState, StatusBadge } from '../components/ui'
import { date, driversOf, relative, shortId } from '../shared/format'

type Filter = 'all' | 'draft' | 'approved'
const platforms = ['all', 'web', 'android', 'desktop', 'api', 'mixed'] as const

function StepList({ steps, cleanup = false }: { steps: StepSpec[]; cleanup?: boolean }) {
  return <ol className="step-outline">
    {steps.map(step => <li key={`${cleanup}-${step.order}`}>
      <span className="step-outline-index">{cleanup ? 'C' : ''}{String(step.order).padStart(2, '0')}</span>
      <div>
        <strong>{step.intent}</strong>
        <p>{step.expected_result?<span>预期：{step.expected_result}</span>:<code>{step.operation}</code>}{step.always_run && <span className="inline-tag">总是执行</span>}</p>
        {step.assertions.length > 0 && <div className="assertion-chips">
          {step.assertions.map((assertion, index) => <span key={index}>
            {assertion.kind}{assertion.path ? ` ${assertion.path}` : ''} = <b>{JSON.stringify(assertion.expected)}</b>
          </span>)}
        </div>}
      </div>
    </li>)}
  </ol>
}

function CaseDetail({ item, busy, onEdit, onApprove, onArchive, onRestore }: { item: CaseRecord; busy: boolean; onEdit: () => void; onApprove: () => void; onArchive: () => void; onRestore: () => void }) {
  const assertions = [...item.steps, ...item.postconditions].reduce((sum, step) => sum + step.assertions.length, 0)
  return <article className="case-detail">
    <header className="case-detail-header">
      <div>
        <p className="eyebrow mono">#{shortId(item.id)} · v{item.version} · {date(item.created_at)}</p>
        <h2>{item.title}</h2>
        {item.description && <p className="case-description">{item.description}</p>}
      </div>
      <div className="case-detail-actions">
        {item.archived_at
          ? <button className="secondary-button" disabled={busy} onClick={onRestore}><Undo2 size={14} />恢复</button>
          : <>
            <button className="icon-button danger" disabled={busy} onClick={onArchive} aria-label={'删除用例 ' + item.title} title="删除（可恢复）"><Trash2 size={16} /></button>
            <button className="secondary-button" disabled={busy} onClick={onEdit}><Pencil size={14} />编辑</button>
            {item.status === 'draft' && <button className="primary-button" disabled={busy} onClick={onApprove}><Check size={14} />批准</button>}
          </>}
      </div>
    </header>
    <dl className="case-facts">
      <div><dt>状态</dt><dd><StatusBadge status={item.archived_at ? 'skipped' : item.status} />{item.archived_at && <span className="muted small">已删除</span>}</dd></div>
      <div><dt>执行端</dt><dd>{platformLabels[platformOf(item)]}</dd></div>
      <div><dt>执行方式</dt><dd>{item.execution_mode === 'agent' ? '自然语言' : '结构化动作'}</dd></div>
      <div><dt>规模</dt><dd className="num">{item.steps.length} 步{item.postconditions.length > 0 && ` + ${item.postconditions.length} 后处理`}{assertions > 0 && ` · ${assertions} 断言`}</dd></div>
    </dl>
    {item.status === 'approved' && !item.archived_at && <p className="quiet-note case-note">已批准版本不可直接修改，编辑后将另存为 v{item.version + 1} 草稿。</p>}
    {item.source_case_id && <p className="quiet-note case-note">从已批准版本修订而来。</p>}
    <h3 className="case-section-title">执行步骤</h3>
    <StepList steps={item.steps} />
    {item.postconditions.length > 0 && <>
      <h3 className="case-section-title">后处理</h3>
      <StepList steps={item.postconditions} cleanup />
    </>}
  </article>
}

export default function Cases({ cases, selectedId, editor, onSelect, onApprove, onCreate, onEdit, onArchive, onRestore }: {
  cases: CaseRecord[]
  selectedId: string | null
  editor: ReactNode
  onSelect: (id: string | null) => void
  onApprove: (id: string) => Promise<void>
  onCreate: (platform: DriverKind) => void
  onEdit: (item: CaseRecord) => void
  onArchive: (id: string) => Promise<void>
  onRestore: (id: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [filter, setFilter] = useState<Filter>('all')
  const [platform, setPlatform] = useState<CasePlatform | 'all'>('all')
  const [archived, setArchived] = useState(false)
  const [busy, setBusy] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLElement>(null)

  const scoped = useMemo(() => filterCases(cases, { platform, status: 'all', query: '', archived }), [cases, platform, archived])
  const filtered = useMemo(() => filterCases(cases, { platform, status: filter, query: deferredQuery, archived }), [cases, platform, filter, deferredQuery, archived])
  const platformCounts = useMemo(() => Object.fromEntries(platforms.map(value => [value, filterCases(cases, { platform: value, status: 'all', query: '', archived }).length])), [cases, archived])
  const approvedCount = scoped.filter(item => item.status === 'approved').length
  const selected = cases.find(item => item.id === selectedId)
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: scoped.length },
    { key: 'draft', label: '草稿', count: scoped.length - approvedCount },
    { key: 'approved', label: '已批准', count: approvedCount },
  ]
  const act = async (id: string, fn: (id: string) => Promise<void>) => { setBusy(id); try { await fn(id) } finally { setBusy('') } }

  // Keep the selection visible in the list and start the detail pane from the top.
  useEffect(() => {
    if (!selectedId) return
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])
  useEffect(() => { paneRef.current?.scrollTo({ top: 0 }) }, [selectedId, Boolean(editor)])

  const moveSelection = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const at = filtered.findIndex(item => item.id === selectedId)
    const next = filtered[Math.max(0, Math.min(filtered.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (next) { onSelect(next.id); listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus() }
  }

  return <div className="cases-page">
    <div className="cases-head">
      <div>
        <h1>用例管理</h1>
        <p className="page-description">按执行端管理用例；跨端场景在测试计划中组合。批准后的修改另存为新草稿版本。</p>
      </div>
      <button className="primary-button" onClick={() => onCreate(platform === 'all' || platform === 'mixed' ? 'web' : platform)}><Plus size={15} /> 新建用例</button>
    </div>

    <div className="cases-layout">
      <aside className="case-list-pane" aria-label="用例列表">
        <div className="case-list-tools">
          <label className="search-field">
            <Search size={15} />
            <input placeholder="搜索标题、描述或 ID…" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索用例" />
          </label>
          <div className="case-list-filters">
            <select className="mini-select" aria-label="按执行端分类" value={platform} onChange={event => setPlatform(event.target.value as CasePlatform | 'all')}>
              {platforms.map(value => <option key={value} value={value}>{value === 'all' ? '全部执行端' : platformLabels[value]} · {platformCounts[value]}</option>)}
            </select>
            <button className={archived ? 'icon-button toggled' : 'icon-button'} aria-pressed={archived} onClick={() => setArchived(!archived)} title={archived ? '返回用例列表' : '查看已删除（可恢复）'} aria-label="显示已删除用例"><Archive size={16} /></button>
          </div>
          <div className="segmented segmented-fill" role="tablist" aria-label="按状态筛选">
            {filters.map(item => <button key={item.key} role="tab" aria-selected={filter === item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>
              {item.label}<span>{item.count}</span>
            </button>)}
          </div>
        </div>
        {archived && <p className="case-list-banner">正在查看已删除的用例</p>}
        <div className="case-list" ref={listRef} role="listbox" aria-label="用例" onKeyDown={moveSelection}>
          {filtered.map(item => {
            const active = item.id === selectedId
            return <button key={item.id} data-id={item.id} role="option" aria-selected={active} tabIndex={active || (!selectedId && item === filtered[0]) ? 0 : -1}
              className={active ? 'case-item active' : 'case-item'} onClick={() => onSelect(item.id)}>
              <span className="case-item-title">
                <span className={`status-pip pip-${item.status}`} title={item.status === 'draft' ? '草稿' : '已批准'} />
                <strong>{item.title}</strong>
              </span>
              <span className="case-item-meta">
                <span className="chip-row">{driversOf([...item.steps, ...item.postconditions]).map(driver => <DriverChip key={driver} driver={driver} />)}</span>
                <span className="num">{item.steps.length} 步</span>
                <span className="mono">v{item.version}</span>
                <time dateTime={item.created_at}>{relative(item.created_at)}</time>
              </span>
            </button>
          })}
          {!filtered.length && <EmptyState icon={ClipboardList} title={cases.length ? '没有匹配的用例' : '还没有用例'} description={cases.length ? '换个关键词或筛选条件试试。' : '从第一个测试场景开始。'} />}
        </div>
        <footer className="case-list-footer num">{filtered.length} 个用例{filtered.length > 0 && ' · ↑↓ 切换'}</footer>
      </aside>

      <section className={editor ? 'case-pane editing' : 'case-pane'} ref={paneRef} aria-live="polite">
        {editor ?? (selected
          ? <CaseDetail key={selected.id} item={selected} busy={busy === selected.id}
              onEdit={() => onEdit(selected)}
              onApprove={() => void act(selected.id, onApprove)}
              onArchive={() => void act(selected.id, onArchive)}
              onRestore={() => void act(selected.id, onRestore)} />
          : <div className="case-pane-empty">
              <div className="case-pane-empty-art" aria-hidden="true"><ClipboardList size={22} /></div>
              <h3>{selectedId ? '找不到这个用例' : '选择一个用例'}</h3>
              <p>从左侧列表查看步骤与断言，或新建一个测试场景。</p>
              <button className="secondary-button" onClick={() => onCreate(platform === 'all' || platform === 'mixed' ? 'web' : platform)}><Plus size={15} /> 新建用例</button>
            </div>)}
      </section>
    </div>
  </div>
}
