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
