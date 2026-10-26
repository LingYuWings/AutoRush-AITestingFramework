import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, type Icon } from './icons'
import type { DriverKind, ResultStatus } from '../shared/api'
import { countStatuses, driverLabel, resultOrder, statusLabel } from '../shared/format'

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}><span className="badge-dot" />{statusLabel[status] ?? status}</span>
}

export function DriverChip({ driver }: { driver: DriverKind }) {
  return <span className={`driver-chip driver-${driver}`}>{driverLabel[driver] ?? driver}</span>
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: Icon; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state">
    <Icon size={18} className="empty-icon" />
    <h3>{title}</h3>
    <p>{description}</p>
    {action}
  </div>
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-heading">
    <div>
      <h1>{title}</h1>
      {description && <p className="page-description">{description}</p>}
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>
}

/** Proportional bar of result statuses, e.g. the cases inside one run. */
export function ResultBar({ items, size = 'md' }: { items: { status: ResultStatus }[]; size?: 'sm' | 'md' }) {
  const counts = countStatuses(items)
  const total = items.length
  if (!total) return <div className={`result-bar result-bar-${size} empty`} />
  return <div className={`result-bar result-bar-${size}`} title={resultOrder.filter(key => counts[key]).map(key => `${statusLabel[key]} ${counts[key]}`).join(' · ')}>
    {resultOrder.filter(key => counts[key]).map(key => <span key={key} className={`seg-${key}`} style={{ flexGrow: counts[key] }} />)}
  </div>
}

export function BrandMark({ size = 30 }: { size?: number }) {
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" className="brand-mark-bg" />
    <path d="M9.5 10.5 15.5 16 9.5 21.5" className="brand-mark-dim" />
    <path d="M17.5 21.5h6" className="brand-mark-hot" />
    <circle cx="22.5" cy="10.5" r="1.9" className="brand-mark-dot" />
  </svg>
}

/** Client-side paging for long lists; jumps back to page 1 whenever `resetKey` changes. */
export function usePaged<T>(items: T[], resetKey: string, pageSize = 20, initialPage = 1) {
  const [state, setState] = useState({ page: initialPage, key: resetKey })
  const page = state.key === resetKey ? state.page : 1
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(page, pageCount)
  return {
    items: items.slice((current - 1) * pageSize, current * pageSize),
    page: current, pageCount, total: items.length, pageSize,
    setPage: (next: number) => setState({ page: next, key: resetKey }),
  }
}

export function Pagination({ page, pageCount, total, pageSize, setPage }: { page: number; pageCount: number; total: number; pageSize: number; setPage: (page: number) => void }) {
  if (pageCount <= 1) return null
  const start = (page - 1) * pageSize + 1
  return <nav className="pagination" aria-label="分页">
    <span className="num">{start}–{Math.min(page * pageSize, total)} / {total}</span>
    <div>
      <button className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
      <span className="pagination-page num">{page} / {pageCount}</span>
      <button className="icon-button" aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
    </div>
  </nav>
}
