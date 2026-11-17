import { startTransition } from 'react'
import { flushSync } from 'react-dom'
import type { View } from './types'

/** `#/reports/<id>`, `#/cases/<id>/edit`, `#/cases/new` … */
export type Route = { view: View; id?: string; edit?: boolean }

const views: View[] = ['overview', 'cases', 'plans', 'reports', 'devices', 'settings', 'api-testing']
// Rank list, detail, and edit routes for directional transitions.
const depth = (route: Route) => (route.id ? 1 : 0) + (route.edit ? 1 : 0)

// Decode a hash into a known console route and fall back to the overview.
export function parseRoute(hash: string): Route {
  const [view, id, mode] = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  if (!views.includes(view as View)) return { view: 'overview' }
  return { view: view as View, id, edit: mode === 'edit' || undefined }
}

// Encode route segments into a shareable browser hash.
export function routeHash(route: Route) {
  return '#/' + [route.view, route.id, route.edit ? 'edit' : ''].filter(Boolean).map(part => encodeURIComponent(part!)).join('/')
}

// Compare routes using their canonical hash.
export const sameRoute = (a: Route, b: Route) => routeHash(a) === routeHash(b)

/**
 * How a navigation should animate (styled in style.css under "View transitions"):
 * - `switch`  another sidebar page: keep the current page visible while its destination loads
 * - `forward` / `back`  drilling into / out of a record: the page slides horizontally
 * - `swap`    sibling record at the same depth (report pager): quick crossfade
 * - `detail`  master–detail pages (cases): only the detail pane changes, the list stays still
 * - `tab`     in-page plan tabs: quick crossfade
 */
export function navKind(from: Route, to: Route) {
  if (from.view !== to.view) return 'switch'
  if (to.view === 'cases') return 'detail'
  if (to.view === 'plans') return 'tab'
  return depth(to) > depth(from) ? 'forward' : depth(to) < depth(from) ? 'back' : 'swap'
}

/** Runs a navigation state update inside a View Transition when the browser supports it. */
export function transition(from: Route, to: Route, update: () => void) {
  const root = document.documentElement
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const token = ++transitionToken
  if (activeTransition) {
    activeTransition.skipTransition()
    activeTransition = undefined
    if (root.dataset.nav !== 'theme') delete root.dataset.nav
  }
  // Keep the previous page visible until its replacement can render, without capturing a snapshot.
  if (from.view !== to.view) { startTransition(update); return }
  const immediate = to.view === 'api-testing' || to.view === 'settings'
  if (!document.startViewTransition || reduced || immediate || document.visibilityState !== 'visible') { update(); return }
  root.dataset.nav = navKind(from, to)
  activeTransition = document.startViewTransition(() => {
    if (token === transitionToken) flushSync(update)
  })
  // Release the snapshot state only if the same navigation is still current.
  const release = () => {
    if (token !== transitionToken) return
    activeTransition = undefined
    if (root.dataset.nav !== 'theme') delete root.dataset.nav
  }
  void activeTransition.finished.then(release, release)
}
let transitionToken = 0
let activeTransition: ViewTransition | undefined
