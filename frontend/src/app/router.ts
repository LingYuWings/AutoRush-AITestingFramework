import { flushSync } from 'react-dom'
import type { View } from './types'

/** `#/reports/<id>`, `#/cases/<id>/edit`, `#/cases/new` … */
export type Route = { view: View; id?: string; edit?: boolean }

const views: View[] = ['overview', 'cases', 'plans', 'reports', 'devices', 'settings', 'api-testing']
const depth = (route: Route) => (route.id ? 1 : 0) + (route.edit ? 1 : 0)

export function parseRoute(hash: string): Route {
  const [view, id, mode] = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  if (!views.includes(view as View)) return { view: 'overview' }
  return { view: view as View, id, edit: mode === 'edit' || undefined }
}

export function routeHash(route: Route) {
  return '#/' + [route.view, route.id, route.edit ? 'edit' : ''].filter(Boolean).map(part => encodeURIComponent(part!)).join('/')
}

export const sameRoute = (a: Route, b: Route) => routeHash(a) === routeHash(b)

/**
 * Runs a navigation state update inside a View Transition when the browser supports it.
 * The direction (deeper / shallower / sideways) is exposed to CSS via `data-nav`.
 */
export function transition(from: Route, to: Route, update: () => void) {
  const root = document.documentElement
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reduced || document.visibilityState !== 'visible') { update(); return }
  root.dataset.nav = from.view !== to.view ? 'switch' : depth(to) > depth(from) ? 'forward' : depth(to) < depth(from) ? 'back' : 'swap'
  const vt = document.startViewTransition(() => flushSync(update))
  void vt.finished.finally(() => { delete root.dataset.nav })
}
