/**
 * AutoRush icon set — flat, geometric, drawn on a 24px grid.
 * Every glyph is a 1.75px round-cap outline plus an optional soft "tint" shape
 * (currentColor at low opacity) that gives the set its two-tone, flat look.
 * Colour always comes from `currentColor`, so icons follow text colour and theme.
 */
import type { ReactNode, SVGProps } from 'react'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number | string }
export type Icon = (props: IconProps) => ReactNode

const TINT = { fill: 'currentColor', fillOpacity: 0.16, stroke: 'none' } as const

function glyph(_name: string, tint: ReactNode, body: ReactNode): Icon {
  const component: Icon = ({ size = 16, className, ...rest }) => (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      className={className ? `ar-icon ${className}` : 'ar-icon'} aria-hidden="true" focusable="false" {...rest}
    >
      {tint && <g {...TINT}>{tint}</g>}
      {body}
    </svg>
  )
  return component
}

// ── Actions ────────────────────────────────────────────────────────────
export const Plus = glyph('Plus', null, <path d="M12 5v14M5 12h14" />)
export const X = glyph('X', null, <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />)
export const Check = glyph('Check', null, <path d="M5 12.5l4.5 4.5L19 7.5" />)
export const Search = glyph('Search', <circle cx="10.5" cy="10.5" r="6.5" />, <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L20 20" /></>)
export const Pencil = glyph('Pencil', <path d="M4 20v-4L15.5 4.5a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L8 20z" />, <><path d="M4 20v-4L15.5 4.5a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L8 20z" /><path d="M13.5 6.5l4 4" /></>)
export const Trash2 = glyph('Trash2', <path d="M6.5 7l.8 11.5a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7z" />, <><path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" /><path d="M6.5 7l.8 11.5a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" /><path d="M10.5 11v5M13.5 11v5" /></>)
export const Undo2 = glyph('Undo2', null, <><path d="M8 7L4 11l4 4" /><path d="M4 11h10a6 6 0 0 1 0 8h-3" /></>)
export const Copy = glyph('Copy', <rect x="9" y="9" width="11" height="11" rx="2.5" />, <><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" /></>)
export const Download = glyph('Download', null, <><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19.5h14" /></>)
export const ExternalLink = glyph('ExternalLink', null, <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>)
export const Play = glyph('Play', <path d="M8 5.5v13l11-6.5z" />, <path d="M8 5.5v13l11-6.5z" />)
export const Square = glyph('Square', <rect x="6" y="6" width="12" height="12" rx="2.5" />, <rect x="6" y="6" width="12" height="12" rx="2.5" />)
export const RefreshCw = glyph('RefreshCw', null, <><path d="M20 11a8 8 0 0 0-14.5-3.5L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.5 3.5L20 15" /><path d="M20 20v-5h-5" /></>)
export const RotateCcw = glyph('RotateCcw', null, <><path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5" /><path d="M4 4v4.5h4.5" /></>)
export const Archive = glyph('Archive', <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5" />, <><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5" /><path d="M5.5 9v8.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9M10 13h4" /></>)

// ── Navigation ─────────────────────────────────────────────────────────
export const ArrowLeft = glyph('ArrowLeft', null, <path d="M19 12H5M11 6l-6 6 6 6" />)
export const ArrowRight = glyph('ArrowRight', null, <path d="M5 12h14M13 6l6 6-6 6" />)
export const ChevronLeft = glyph('ChevronLeft', null, <path d="M15 5l-7 7 7 7" />)
export const ChevronRight = glyph('ChevronRight', null, <path d="M9 5l7 7-7 7" />)

// ── Sections ───────────────────────────────────────────────────────────
export const LayoutDashboard = glyph('LayoutDashboard',
  <><rect x="4" y="4" width="7" height="9" rx="1.8" /><rect x="13" y="11" width="7" height="9" rx="1.8" /></>,
  <><rect x="4" y="4" width="7" height="9" rx="1.8" /><rect x="13" y="4" width="7" height="5" rx="1.8" /><rect x="13" y="11" width="7" height="9" rx="1.8" /><rect x="4" y="15" width="7" height="5" rx="1.8" /></>)
export const ClipboardList = glyph('ClipboardList', <rect x="5" y="5" width="14" height="16" rx="2.5" />,
  <><rect x="5" y="5" width="14" height="16" rx="2.5" /><rect x="9" y="3" width="6" height="4" rx="1.2" /><path d="M9 12h6M9 16h4" /></>)
export const Workflow = glyph('Workflow', <rect x="4" y="4" width="6" height="6" rx="1.6" />,
  <><rect x="4" y="4" width="6" height="6" rx="1.6" /><rect x="14" y="14" width="6" height="6" rx="1.6" /><path d="M10 7h4a3 3 0 0 1 3 3v4" /></>)
export const FileText = glyph('FileText', <path d="M14 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8z" />,
  <><path d="M14 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8z" /><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" /></>)
export const Settings2 = glyph('Settings2', <><circle cx="15" cy="8" r="2.2" /><circle cx="9" cy="16" r="2.2" /></>,
  <><path d="M4 8h8.8M17.2 8H20M4 16h2.8M11.2 16H20" /><circle cx="15" cy="8" r="2.2" /><circle cx="9" cy="16" r="2.2" /></>)

// ── Platforms & infrastructure ─────────────────────────────────────────
export const Smartphone = glyph('Smartphone', <rect x="7" y="3" width="10" height="18" rx="2.6" />, <><rect x="7" y="3" width="10" height="18" rx="2.6" /><path d="M11 17.5h2" /></>)
export const Monitor = glyph('Monitor', <rect x="3" y="4.5" width="18" height="12" rx="2.2" />, <><rect x="3" y="4.5" width="18" height="12" rx="2.2" /><path d="M9 20h6M12 16.5V20" /></>)
export const Globe = glyph('Globe', <circle cx="12" cy="12" r="8.5" />, <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.4 3.6 5.3 3.6 8.5s-1.1 6.1-3.6 8.5c-2.5-2.4-3.6-5.3-3.6-8.5S9.5 5.9 12 3.5z" /></>)
export const Server = glyph('Server', <rect x="4" y="4" width="16" height="6.5" rx="2" />,
  <><rect x="4" y="4" width="16" height="6.5" rx="2" /><rect x="4" y="13.5" width="16" height="6.5" rx="2" /><path d="M8 7.25h.01M8 16.75h.01" /></>)
export const Usb = glyph('Usb', <path d="M10.5 5.5L12 3l1.5 2.5z" />, <><path d="M12 5v13" /><path d="M10.5 5.5L12 3l1.5 2.5z" /><circle cx="12" cy="19.5" r="1.6" /><path d="M12 13l4-2.5V8.5M12 10.5l-3.5-2" /><rect x="14.8" y="6" width="2.4" height="2.5" rx=".5" /></>)
export const Radio = glyph('Radio', null, <><circle cx="12" cy="12" r="1.8" fill="currentColor" /><path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" /></>)
export const QrCode = glyph('QrCode', <><rect x="4" y="4" width="6" height="6" rx="1.2" /><rect x="14" y="4" width="6" height="6" rx="1.2" /><rect x="4" y="14" width="6" height="6" rx="1.2" /></>,
  <><rect x="4" y="4" width="6" height="6" rx="1.2" /><rect x="14" y="4" width="6" height="6" rx="1.2" /><rect x="4" y="14" width="6" height="6" rx="1.2" /><path d="M14 14h2.5v2.5M20 14v.01M14 20h.01M17 20h3v-3" /></>)
export const Unplug = glyph('Unplug', <path d="M7 8h10v3a5 5 0 0 1-10 0z" />, <><path d="M9 4v4M15 4v4M7 8h10v3a5 5 0 0 1-10 0zM12 16v4" /></>)
export const KeyRound = glyph('KeyRound', <circle cx="8.5" cy="15.5" r="3.8" />, <><circle cx="8.5" cy="15.5" r="3.8" /><path d="M11.2 12.8L19 5M16 8l2.5 2.5M13.8 10.2L15.7 12" /></>)
export const ShieldCheck = glyph('ShieldCheck', <path d="M12 3.5l7 2.5v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />, <><path d="M12 3.5l7 2.5v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></>)

// ── Status & appearance ────────────────────────────────────────────────
export const CircleCheck = glyph('CircleCheck', <circle cx="12" cy="12" r="8.5" />, <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.5 2.5 4.5-5" /></>)
export const CheckCircle2 = CircleCheck
export const CircleAlert = glyph('CircleAlert', <circle cx="12" cy="12" r="8.5" />, <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5M12 16h.01" /></>)
export const CloudOff = glyph('CloudOff', <path d="M6.5 18.5h11a3.5 3.5 0 0 0 .6-6.95A6 6 0 0 0 6.6 10.6a4 4 0 0 0-.1 7.9z" />,
  <><path d="M6.5 18.5h11a3.5 3.5 0 0 0 .6-6.95A6 6 0 0 0 6.6 10.6a4 4 0 0 0-.1 7.9z" /><path d="M4 4l16 16" /></>)
export const Sun = glyph('Sun', <circle cx="12" cy="12" r="4" />,
  <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></>)
export const Moon = glyph('Moon', <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />, <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />)
