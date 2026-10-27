export type View = 'overview' | 'cases' | 'plans' | 'reports' | 'devices' | 'settings' | 'api-testing'

export type LiveEvent = { id: string; at: string; text: string; tone: 'info' | 'passed' | 'failed' }

export type RunProgress = { runId: string; completed: number; total: number }
