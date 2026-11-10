// Shared header row for every step card in the case editor (natural-language, structured and API nodes).
import { uiText } from '../../shared/i18n.ts'
import { ChevronDown, ChevronUp, Trash2 } from '../../components/icons'
import { DriverChip } from '../../components/ui'
import type { DriverKind } from '../../shared/api'

// Show the step number, title and driver, plus reorder and delete controls.
export default function StepHeading({ index, cleanup = false, title, driver, onMoveUp, onMoveDown, onRemove }: {
  index: number
  cleanup?: boolean
  title: string
  driver?: DriverKind
  onMoveUp?: () => void
  onMoveDown?: () => void
  onRemove: () => void
}) {
  const label = `${cleanup ? uiText("后处理") : uiText("步骤")} ${index + 1}`
  const reorderable = Boolean(onMoveUp || onMoveDown)
  return <div className="step-heading">
    <span className="step-number">{cleanup ? 'C' : ''}{String(index + 1).padStart(2, '0')}</span>
    <strong>{title}</strong>
    {driver && <DriverChip driver={driver} />}
    <div className="step-heading-actions">
      {reorderable && <>
        <button type="button" className="icon-button" disabled={!onMoveUp} onClick={onMoveUp} aria-label={uiText("上移{0}", label)} title={uiText("上移")}><ChevronUp size={16} /></button>
        <button type="button" className="icon-button" disabled={!onMoveDown} onClick={onMoveDown} aria-label={uiText("下移{0}", label)} title={uiText("下移")}><ChevronDown size={16} /></button>
      </>}
      <button type="button" className="icon-button danger" onClick={onRemove} aria-label={uiText("删除{0}", label)} title={uiText("删除")}><Trash2 size={16} /></button>
    </div>
  </div>
}
