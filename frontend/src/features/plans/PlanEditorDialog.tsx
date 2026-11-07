import { useLayoutEffect, useRef, type ReactNode } from 'react'

// Keep the plan editor in the native modal layer and restore focus on close.
export default function PlanEditorDialog({ open, saving, onClose, children }: {
  open: boolean
  saving: boolean
  onClose: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const panel = dialog.current
    if (!panel) return
    if (open && !panel.open) {
      panel.showModal()
      panel.querySelector<HTMLElement>('[data-plan-initial-focus]')?.focus({ preventScroll: true })
    } else if (!open && panel.open) {
      panel.close()
    }
  }, [open])

  return <dialog ref={dialog} className="plan-dialog" aria-labelledby="plan-dialog-title" onCancel={event => {
    event.preventDefault()
    if (!saving) onClose()
  }}>{children}</dialog>
}
