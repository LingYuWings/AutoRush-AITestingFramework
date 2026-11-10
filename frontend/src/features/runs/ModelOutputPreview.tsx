// Render model replies as readable text, structured fields, and inert element previews.
import { Fragment, memo, type ReactNode } from 'react'
import { uiText } from '../../shared/i18n.ts'
import { decodeModelEntities, decodeModelProse, parseModelPreview } from './model-output-format'

const htmlTags = /<\/?(?:a|article|b|blockquote|br|button|code|div|em|fieldset|form|h[1-6]|hr|img|input|label|li|ol|option|p|pre|section|select|span|strong|table|tbody|td|textarea|th|thead|tr|ul)(?=[\s/>])/i
const controls = new Set(['a', 'button', 'img', 'input', 'select', 'textarea'])
const discarded = new Set(['script', 'style', 'template', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'svg', 'math', 'noscript'])
const maxDepth = 7
const maxChildren = 60

// Provide a formatted view by default and keep the exact saved reply available.
export default memo(function ModelOutputPreview({ text }: { text: string }) {
  const preview = parseModelPreview(text)
  return <section className="model-output-preview">
    {preview.kind === 'json' ? <JsonValue value={preview.value} depth={0} /> : <TextPreview text={preview.value} decoded={preview.decoded} />}
    <details className="model-output-source">
      <summary>{uiText('查看原始文本')}</summary>
      <pre>{text}</pre>
    </details>
  </section>
})

// Show JSON objects as fields and arrays as lists without escaping text a second time.
function JsonValue({ value, depth }: { value: unknown; depth: number }) {
  if (typeof value === 'string') return value ? <TextPreview text={value} decoded /> : <code>""</code>
  if (value === null || typeof value !== 'object') return <code>{String(value)}</code>
  if (depth >= maxDepth) return <span className="quiet-note">{uiText('展开原始文本可查看其余内容。')}</span>
  if (Array.isArray(value)) {
    if (!value.length) return <code>[]</code>
    return <ol className="model-output-array">
      {value.slice(0, maxChildren).map((item, index) => <li key={index}><JsonValue value={item} depth={depth + 1} /></li>)}
      {value.length > maxChildren && <li className="quiet-note">{uiText('展开原始文本可查看其余内容。')}</li>}
    </ol>
  }
  const fields = Object.entries(value)
  if (!fields.length) return <code>{'{}'}</code>
  return <>
    <dl className="model-output-fields">
      {fields.slice(0, maxChildren).map(([key, item]) => <Fragment key={key}>
        <dt><code>{key}</code></dt>
        <dd><JsonValue value={item} depth={depth + 1} /></dd>
      </Fragment>)}
    </dl>
    {fields.length > maxChildren && <p className="quiet-note">{uiText('展开原始文本可查看其余内容。')}</p>}
  </>
}

// Preserve code fences and support basic Markdown structure and element snippets.
function TextPreview({ text, decoded = false }: { text: string; decoded?: boolean }) {
  const source = !decoded && !text.includes('\n') && text.trimStart().startsWith('\x60\x60\x60') ? decodeModelProse(text) : text
  const fence = /^\x60{3}([\w-]*)[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}[ \t]*$/gm
  const parts: ReactNode[] = []
  let offset = 0
  for (const match of source.matchAll(fence)) {
    if (match.index > offset) parts.push(<Prose key={offset} text={source.slice(offset, match.index)} decoded={decoded} />)
    parts.push(/^(html|xml)$/i.test(match[1])
      ? <ElementPreview key={match.index} text={match[2]} />
      : <pre key={match.index}><code>{match[2]}</code></pre>)
    offset = match.index + match[0].length
  }
  if (offset < source.length) parts.push(<Prose key={offset} text={source.slice(offset)} decoded={decoded} />)
  return <div className="model-output-text">{parts}</div>
}

// Display paragraphs, headings, lists, and inline formatting using React text nodes.
function Prose({ text, decoded: alreadyDecoded }: { text: string; decoded: boolean }) {
  const source = alreadyDecoded ? text : decodeModelProse(text)
  const decoded = decodeModelEntities(source)
  if (htmlTags.test(source)) return <ElementPreview text={source} />
  if (htmlTags.test(decoded)) return <ElementPreview text={decoded} />
  return decoded.trimEnd().split(/\r?\n[ \t]*\r?\n/).filter(Boolean).map((paragraph, index) => {
    const lines = paragraph.split(/\r?\n/)
    if (lines.every(line => /^\s*(?:[-*+]|\d+\.)\s+/.test(line))) {
      const List = /^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul'
      return <List key={index}>{lines.map((line, item) => <li key={item}><InlineText text={line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')} /></li>)}</List>
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[0])
    if (heading) return <div key={index}><h4><InlineText text={heading[2]} /></h4>
      {lines.length > 1 && <p><InlineText text={lines.slice(1).join('\n')} /></p>}
    </div>
    return <p key={index}><InlineText text={paragraph} /></p>
  })
}

// Render inline emphasis and code without turning model-provided URLs into links.
function InlineText({ text }: { text: string }) {
  return text.split(/(\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    if (index % 2 === 0) return part
    return part.startsWith('\x60') ? <code key={index}>{part.slice(1, -1)}</code> : <strong key={index}>{part.slice(2, -2)}</strong>
  })
}

// Parse markup in an inert template and render only locally constructed preview nodes.
function ElementPreview({ text }: { text: string }) {
  const template = document.createElement('template')
  template.innerHTML = text
  return <div className="model-output-elements">
    <span className="muted">{uiText('页面元素预览')}</span>
    <div>{previewNodes(template.content.childNodes, 0)}</div>
  </div>
}

// Project safe semantic markup and represent interactive controls as static labels.
function previewNodes(nodes: NodeListOf<ChildNode>, depth: number): ReactNode {
  if (depth >= maxDepth) return null
  return Array.from(nodes).slice(0, maxChildren).map((node, index) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent
    if (!(node instanceof Element)) return null
    const tag = node.localName
    if (discarded.has(tag)) return null
    const children = previewNodes(node.childNodes, depth + 1)
    if (controls.has(tag)) {
      const label = node.getAttribute('aria-label') ?? node.getAttribute('placeholder') ?? node.getAttribute('alt')
      const id = node.getAttribute('id')
      const type = node.getAttribute('type')
      const description = '<' + tag + (id ? '#' + id : '') + (type ? ' · ' + type : '') + '>'
      return <span key={index} className="model-output-element">
        <code>{description}</code>
        {label ? <span>{label}</span> : tag !== 'input' && tag !== 'img' ? children : null}
      </span>
    }
    switch (tag) {
      case 'br': return <br key={index} />
      case 'hr': return <hr key={index} />
      case 'b': case 'strong': return <strong key={index}>{children}</strong>
      case 'em': case 'i': return <em key={index}>{children}</em>
      case 'code': return <code key={index}>{children}</code>
      case 'ul': return <ul key={index}>{children}</ul>
      case 'ol': return <ol key={index}>{children}</ol>
      case 'li': return <li key={index}>{children}</li>
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return <h4 key={index}>{children}</h4>
      case 'p': case 'label': return <p key={index}>{children}</p>
      case 'div': case 'section': case 'article': case 'form': case 'tr': return <div key={index}>{children}</div>
      case 'td': case 'th': case 'option': return <span key={index} className="model-output-element">{children}</span>
      default: return <Fragment key={index}>{children}</Fragment>
    }
  })
}
