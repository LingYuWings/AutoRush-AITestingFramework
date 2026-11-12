// Decode reply envelopes and display escapes without modifying the saved source.
export type ModelPreview = { kind: 'json'; value: unknown } | { kind: 'text'; value: string; decoded?: boolean }

// Unwrap JSON and fenced JSON while keeping incomplete stream fragments readable.
export function parseModelPreview(source: string): ModelPreview {
  const trimmed = source.trim()
  const fenced = /^\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/i.exec(trimmed)
  const candidate = fenced?.[1] ?? trimmed
  if (/^[{["]/.test(candidate)) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'string') return { kind: 'text', value, decoded: true }
      if (value !== null && typeof value === 'object') return { kind: 'json', value }
    } catch { /* An in-progress response can still be displayed as text. */ }
  }
  return { kind: 'text', value: source }
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

// Decode common named and numeric entities once for safe text or element previews.
export function decodeModelEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const name = entity.toLowerCase()
    if (!name.startsWith('#')) return entities[name] ?? match
    const hex = name.startsWith('#x')
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match
  })
}

// Convert display escapes in prose while preserving ordinary Windows paths.
export function decodeModelProse(value: string): string {
  return value.replace(/(?:\b[A-Za-z]:\\|\\\\(?=[^\\\s]+\\))[^\s<>"\x60]+|\\\\|\\r\\n|\\[nrt]/g, match => {
    switch (match) {
      case '\\r\\n':
      case '\\n':
      case '\\r': return '\n'
      case '\\t': return '\t'
      default: return match
    }
  })
}

type Fields = [string, unknown][]
type Assertion = { kind: string; expected: unknown; path?: string }
// A model decision reduced to what a reviewer needs: what it did or checked, and why.
export type DecisionView =
  | { kind: 'action'; operation: string; driver?: string; parameters: Fields; element?: string; coordinates?: string; reason?: string; rest: Fields }
  | { kind: 'verify'; expected?: string; check: { mode: 'deterministic'; assertions: Assertion[] } | { mode: 'visual'; passed: boolean | null; explanation?: string } | null; reason?: string; rest: Fields }
  | { kind: 'blocked'; reason?: string; rest: Fields }
  | { kind: 'verdict'; expected?: string; satisfied: boolean; evidence?: string; rest: Fields }

// Bookkeeping fields that identify the observation but say nothing about the decision itself.
const quietFields = new Set(['kind', 'observation_id'])
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined

// Recognize the agent decision contract (action / verify / blocked) and the independent goal verdict;
// anything else stays a generic JSON view.
export function readDecision(value: unknown): DecisionView | null {
  if (!isRecord(value)) return null
  const used = new Set(quietFields)
  const take = (key: string) => { used.add(key); return value[key] }
  const rest = () => Object.entries(value).filter(([key]) => !used.has(key))
  const reason = text(take('brief_reason'))
  if (value.kind === 'action') {
    const operation = text(take('operation'))
    const parameters = take('parameters')
    if (!operation || (parameters !== undefined && !isRecord(parameters))) return null
    const space = text(take('coordinate_space'))
    return { kind: 'action', operation, driver: text(take('driver')), parameters: Object.entries(parameters ?? {}),
      element: text(take('element_id')), coordinates: space === 'normalized_1000' ? space : undefined, reason, rest: rest() }
  }
  if (value.kind === 'verify') {
    const expected = text(take('expected_result'))
    const check = take('check')
    let view: Extract<DecisionView, { kind: 'verify' }>['check'] = null
    if (isRecord(check) && check.kind === 'deterministic' && Array.isArray(check.assertions)) {
      const assertions = check.assertions.filter(isRecord).filter(item => typeof item.kind === 'string')
        .map(item => ({ kind: item.kind as string, expected: item.expected, path: text(item.path) }))
      view = { mode: 'deterministic', assertions }
    } else if (isRecord(check) && check.kind === 'visual') {
      view = { mode: 'visual', passed: typeof check.passed === 'boolean' ? check.passed : null, explanation: text(check.explanation) }
    } else if (check !== undefined) {
      used.delete('check')
    }
    return { kind: 'verify', expected, check: view, reason, rest: rest() }
  }
  if (value.kind === 'blocked') return { kind: 'blocked', reason, rest: rest() }
  if (value.kind === undefined && typeof value.satisfied === 'boolean' && 'expected_result' in value) {
    used.delete('brief_reason')
    const satisfied = take('satisfied') as boolean
    return { kind: 'verdict', expected: text(take('expected_result')), satisfied, evidence: text(take('evidence')), rest: rest() }
  }
  return null
}

// Show a parameter value compactly: scalars as-is, key lists joined, anything nested as JSON.
export function formatDecisionValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number')) return value.join(' + ')
  return JSON.stringify(value) ?? String(value)
}

// Split an execution result line such as "desktop.click · passed" into its action and outcome.
export function splitOutcome(line: string): { action: string; status: 'passed' | 'failed' | 'blocked' | 'error' | 'skipped' } | null {
  const match = /^(.*\S) · (passed|failed|blocked|error|skipped)$/.exec(line)
  return match ? { action: match[1], status: match[2] as 'passed' } : null
}
