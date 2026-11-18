// Highlight the real console controls referenced by the in-app guide.
import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, X } from '../components/icons'
import { uiText } from '../shared/i18n.ts'
import type { TutorialTour } from './tutorialGuides'
import './tutorial-guide.css'

type GuideBox = { left: number; top: number; width: number; height: number }
type GuideLayout = { target: string; spotlight: GuideBox; card: GuideBox; connector: string | null }

// Pad the highlighted control and clip the result to the viewport.
function getSpotlight(rect?: DOMRect): GuideBox | null {
  if (!rect?.width || !rect.height) return null
  const left = Math.max(4, Math.floor(rect.left) - 5)
  const top = Math.max(4, Math.floor(rect.top) - 5)
  const width = Math.min(window.innerWidth - 4, Math.ceil(rect.right) + 5) - left
  const height = Math.min(window.innerHeight - 4, Math.ceil(rect.bottom) + 5) - top
  return width > 0 && height > 0 ? { left, top, width, height } : null
}

// Place the card next to the highlight, clamping it to the visible window.
function placeGuide(spotlight: GuideBox, card: HTMLElement): GuideBox {
  const margin = 16
  const gap = 32
  const { left, top, width, height } = spotlight
  const right = left + width
  const bottom = top + height
  const cardWidth = card.offsetWidth
  const cardHeight = card.offsetHeight
  const maxLeft = window.innerWidth - cardWidth - margin
  const maxTop = window.innerHeight - cardHeight - margin
  let x = left + (width - cardWidth) / 2
  let y = bottom + gap
  if (right + gap <= maxLeft || left - gap - cardWidth >= margin) {
    x = right + gap <= maxLeft ? right + gap : left - gap - cardWidth
    y = top + (height - cardHeight) / 2
  } else if (y > maxTop && top > window.innerHeight - bottom) {
    y = top - gap - cardHeight
  }
  return {
    left: Math.max(margin, Math.min(maxLeft, Math.round(x))),
    top: Math.max(margin, Math.min(maxTop, Math.round(y))),
    width: cardWidth,
    height: cardHeight,
  }
}

// Curve the line between the facing edges, hiding it when the boxes overlap.
function connectGuide(spotlight: GuideBox, card: GuideBox): string | null {
  const horizontalGap = Math.max(card.left - spotlight.left - spotlight.width, spotlight.left - card.left - card.width)
  const verticalGap = Math.max(card.top - spotlight.top - spotlight.height, spotlight.top - card.top - card.height)
  if (horizontalGap < 8 && verticalGap < 8) return null
  const start = edgeFacing(spotlight, card)
  const end = edgeFacing(card, spotlight)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const distance = Math.hypot(dx, dy)
  const bend = Math.min(12, distance / 3)
  const middleX = (start.x + end.x) / 2 + dy / distance * bend
  const middleY = (start.y + end.y) / 2 - dx / distance * bend
  return `M ${start.x} ${start.y} Q ${middleX} ${middleY} ${end.x} ${end.y}`
}

// Find the point in a box nearest to the center of its counterpart.
function edgeFacing(box: GuideBox, other: GuideBox) {
  return {
    x: Math.max(box.left, Math.min(box.left + box.width, other.left + other.width / 2)),
    y: Math.max(box.top, Math.min(box.top + box.height, other.top + other.height / 2)),
  }
}

// Keep keyboard focus in the tour while displaying the current page underneath it.
export default function TutorialGuide({ tour, index, onStep, onClose }: {
  tour: TutorialTour
  index: number
  onStep: (index: number) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const card = useRef<HTMLElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const [layout, setLayout] = useState<GuideLayout | null>(null)
  const { target, title, description } = tour.steps[index]
  const last = index === tour.steps.length - 1

  useLayoutEffect(() => {
    const modal = dialog.current
    if (!modal) return
    modal.showModal()
    return () => { modal.close() }
  }, [])

  useLayoutEffect(() => {
    next.current?.focus({ preventScroll: true })
  }, [index])

  useLayoutEffect(() => {
    const panel = card.current
    const workspace = document.querySelector('main')
    if (!panel || !workspace) return
    let anchor: HTMLElement | null = null
    let frame = 0
    let disposed = false
    const sizes = new ResizeObserver(schedule)
    const content = new MutationObserver(schedule)
    // Keep the previous geometry while the destination mounts so the layers can move together.
    const staleLayout = window.setTimeout(() => setLayout(previous => previous?.target === target ? previous : null), 600)

    // Reposition once per frame as lazy pages mount, scroll, or change size.
    function schedule() {
      if (!disposed && !frame) frame = requestAnimationFrame(measure)
    }

    // Measure the visible part of the new control and avoid stale highlights during navigation.
    function measure() {
      frame = 0
      if (!panel || !workspace) return
      const candidate = workspace.querySelector<HTMLElement>(`[data-tutorial-target="${target}"]`)
      const found = candidate?.getClientRects().length ? candidate : null
      if (found !== anchor) {
        if (anchor) sizes.unobserve(anchor)
        anchor = found
        if (anchor) {
          sizes.observe(anchor)
          anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
          for (const animation of workspace.getAnimations()) void animation.finished.then(schedule, schedule)
        }
      }
      const spotlight = getSpotlight(anchor?.getBoundingClientRect())
      if (!spotlight) {
        setLayout(previous => previous?.target === target ? null : previous)
        return
      }
      const position = placeGuide(spotlight, panel)
      const connector = connectGuide(spotlight, position)
      setLayout(previous => previous?.target === target && previous.card.left === position.left && previous.card.top === position.top
        && previous.spotlight.left === spotlight.left && previous.spotlight.top === spotlight.top
        && previous.spotlight.width === spotlight.width && previous.spotlight.height === spotlight.height
        && previous.connector === connector ? previous : { target, spotlight, card: position, connector })
    }

    sizes.observe(panel)
    content.observe(workspace, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      disposed = true
      window.clearTimeout(staleLayout)
      cancelAnimationFrame(frame)
      sizes.disconnect()
      content.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [target])

  return <dialog ref={dialog} className="tutorial-guide" aria-labelledby="tutorial-guide-title" aria-describedby="tutorial-guide-description"
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); onStep(index - 1) }
      if (event.key === 'ArrowRight' && !last) { event.preventDefault(); onStep(index + 1) }
    }}>
    {layout ? <div aria-hidden="true" className="tutorial-guide-spotlight" style={layout.spotlight} />
      : <div aria-hidden="true" className="tutorial-guide-shade" />}
    {layout?.connector && <svg className="tutorial-guide-connector" aria-hidden="true">
      <path d={layout.connector} style={{ d: `path("${layout.connector}")` }} />
    </svg>}
    <section ref={card} className="tutorial-guide-card" data-anchored={layout ? '' : undefined}
      style={layout ? { left: layout.card.left, top: layout.card.top } : undefined}>
      <div className="tutorial-guide-header">
        <div><strong>{uiText(tour.title)}</strong><span>{uiText('第 {0} 步，共 {1} 步', index + 1, tour.steps.length)}</span></div>
        <button type="button" className="icon-button" aria-label={uiText('退出引导')} onClick={onClose}><X size={16} /></button>
      </div>
      <progress aria-label={uiText('引导进度')} max={tour.steps.length} value={index + 1} />
      <div aria-live="polite">
        <div className="tutorial-guide-copy" key={index}>
          <h2 id="tutorial-guide-title">{uiText(title)}</h2>
          <p id="tutorial-guide-description">{uiText(description)}</p>
        </div>
      </div>
      <div className="tutorial-guide-actions">
        <button type="button" className="secondary-button" disabled={index === 0} onClick={() => onStep(index - 1)}>
          <ArrowLeft size={14} />{uiText('上一步')}
        </button>
        <button type="button" ref={next} className="primary-button" onClick={last ? onClose : () => onStep(index + 1)}>
          {last ? uiText('完成引导') : <>{uiText('下一步')}<ArrowRight size={14} /></>}
        </button>
      </div>
    </section>
  </dialog>
}
