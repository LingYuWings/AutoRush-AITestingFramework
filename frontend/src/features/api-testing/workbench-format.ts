// Convert request rows to bulk text and find literal matches in response bodies.
import type { Pair } from './types'

// Preserve order, duplicate keys and disabled entries when switching to bulk editing.
export function formatPairs(rows: Pair[]): string {
  return rows.map(({ key, value, enabled }) => {
    const label = /[:"]|^# |^\s|\s$/.test(key) ? JSON.stringify(key) : key
    return `${enabled ? '' : '# '}${label}: ${value}`
  }).join('\n')
}

// Read one key/value pair per line and report the first invalid row without changing the request.
export function parsePairs(source: string): { rows: Pair[] } | { line: number } {
  const rows: Pair[] = []
  const lines = source.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    const enabled = !line.startsWith('# ')
    const entry = enabled ? line : line.slice(2)
    const quoted = /^("(?:\\.|[^"\\])*")\s*:/.exec(entry)
    const separator = quoted ? quoted[0].length - 1 : entry.indexOf(':')
    if (separator < 0 || rows.length === 100 || /[\r\0]/.test(entry)) return { line: index + 1 }
    let key = entry.slice(0, separator).trim()
    if (quoted) {
      try { key = JSON.parse(quoted[1]) } catch { return { line: index + 1 } }
    }
    const value = entry.slice(separator + 1).replace(/^ /, '')
    if (/[\r\n\0]/.test(key) || key.length > 512 || value.length > 65536) return { line: index + 1 }
    rows.push({ key, value, enabled })
  }
  return { rows }
}

// Find matches in original string coordinates even when Unicode case folding changes length.
export function searchResponse(body: string, query: string): number[] {
  if (!query) return []
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return Array.from(body.matchAll(new RegExp(literal, 'giu')), match => match.index)
}
