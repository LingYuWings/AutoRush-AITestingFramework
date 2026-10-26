import type { DriverKind, ResultStatus, StepSpec } from './api'

export const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export const relative = (value: string) => {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`
  return date(value)
}

export const shortId = (id: string) => id.slice(0, 8).toUpperCase()

export const statusLabel: Record<string, string> = {
  draft: '草稿', approved: '已批准', ready: '就绪', passed: '通过', failed: '失败',
  error: '错误', blocked: '阻塞', skipped: '跳过', unverified: '待验证', verified: '已验证',
}

export const driverLabel: Record<DriverKind, string> = { api: 'API', web: 'Web', android: 'Android', desktop: 'Desktop' }

export const driversOf = (steps: StepSpec[]) => [...new Set(steps.map(step => step.driver))]

export const resultOrder: ResultStatus[] = ['passed', 'failed', 'error', 'blocked', 'skipped']

export const countStatuses = (items: { status: ResultStatus }[]) => {
  const counts: Record<ResultStatus, number> = { passed: 0, failed: 0, error: 0, blocked: 0, skipped: 0 }
  for (const item of items) counts[item.status] += 1
  return counts
}
