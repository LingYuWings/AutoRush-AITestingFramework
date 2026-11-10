import { uiLanguage, uiText } from './i18n.ts'
import type { DriverKind, ResultStatus, StepSpec } from './api'

// Format a timestamp for the selected console language.
export const date = (value: string) => new Date(value).toLocaleString(uiLanguage, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

const englishElapsed = new Intl.RelativeTimeFormat('en')

// Display a timestamp as elapsed time from now.
export const relative = (value: string) => {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return uiText("刚刚")
  if (uiLanguage === 'en') {
    if (seconds < 3600) return englishElapsed.format(-Math.floor(seconds / 60), 'minute')
    if (seconds < 86400) return englishElapsed.format(-Math.floor(seconds / 3600), 'hour')
    if (seconds < 86400 * 7) return englishElapsed.format(-Math.floor(seconds / 86400), 'day')
    return date(value)
  }
  if (seconds < 3600) return uiText("{0} 分钟前", Math.floor(seconds / 60))
  if (seconds < 86400) return uiText("{0} 小时前", Math.floor(seconds / 3600))
  if (seconds < 86400 * 7) return uiText("{0} 天前", Math.floor(seconds / 86400))
  return date(value)
}

// Create a compact uppercase label from the first eight ID characters.
export const shortId = (id: string) => id.slice(0, 8).toUpperCase()

export const statusLabel: Record<string, string> = {
  draft: uiText("草稿"), approved: uiText("已批准"), ready: uiText("就绪"), passed: uiText("通过"), failed: uiText("失败"),
  error: uiText("错误"), blocked: uiText("阻塞"), skipped: uiText("跳过"), unverified: uiText("待验证"), verified: uiText("已验证"),
}

export const driverLabel: Record<DriverKind, string> = { api: 'API', web: 'Web', android: 'Android', desktop: 'Desktop' }

// List each driver used by the steps once, in first-seen order.
export const driversOf = (steps: StepSpec[]) => [...new Set(steps.map(step => step.driver))]

export const resultOrder: ResultStatus[] = ['passed', 'failed', 'error', 'blocked', 'skipped']

// Count outcomes by status for result summaries.
export const countStatuses = (items: { status: ResultStatus }[]) => {
  const counts: Record<ResultStatus, number> = { passed: 0, failed: 0, error: 0, blocked: 0, skipped: 0 }
  for (const item of items) counts[item.status] += 1
  return counts
}
