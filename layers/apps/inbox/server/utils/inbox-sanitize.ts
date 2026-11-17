// Allowlist sanitizer for untrusted HTML (inbound email bodies) that gets
// embedded into OUTBOUND email we send: quoted history and staff reply
// bodies. The browser thread view sanitizes separately (DOMPurify) before
// `v-html`; this guards the email sinks, which never pass through the
// browser. Keeps common formatting; drops scripts, event handlers, and
// dangerous URL schemes.
import sanitizeHtml from 'sanitize-html'

export function inboxSanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return ''
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'width', 'height', 'style'],
      a: ['href', 'name', 'target', 'rel'],
      '*': ['style']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
    }
  })
}

// Internal-note bodies: staff-authored rich HTML rendered only in the browser
// (never an email sink). Email formatting minus images, plus the Tiptap
// mention span (data-type / data-id / data-label) so @mentions survive the
// round trip — the server extracts notification recipients from THIS
// sanitized markup, never from a client-supplied id list.
export function inboxSanitizeNoteHtml(html: string | null | undefined): string {
  if (!html) return ''
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel'],
      span: ['data-type', 'data-id', 'data-label', 'class']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
    }
  })
}

// text/plain rendering of an HTML body (outbound text parts, quoted history,
// transport fallbacks). Block-close tags become newlines BEFORE the strip so
// adjacent blocks don't jam into one word — `<p>a</p><p>b</p>` must read
// "a\nb", never "ab".
export function inboxHtmlToText(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<\s*(?:br\s*\/?|\/(?:p|h[1-6]|li|div|tr|blockquote))\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
}

const QUOTE_CLASS_RE = /\b(?:gmail_quote|moz-cite-prefix|yahoo_quoted)\b/

// The reply without its quoted history: drops <blockquote> and the common
// client quote containers, otherwise leaves the HTML as received (the thread
// view sanitizes before rendering). '' when nothing but quotes remains.
export function inboxStripQuotedHtml(html: string | null | undefined): string {
  if (!html) return ''
  const stripped = sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    exclusiveFilter: frame => frame.tag === 'blockquote' || QUOTE_CLASS_RE.test(frame.attribs?.class ?? '')
  })
  return inboxHtmlToText(stripped).trim() ? stripped : ''
}

// The plain-text reply without its quoted history: everything before the
// first quoted line, "On … wrote:" attribution or forwarded-original marker.
export function inboxStripQuotedText(text: string | null | undefined): string {
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  const cut = lines.findIndex(l => /^\s*>/.test(l) || /^\s*On\b.*\bwrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l))
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim()
  return kept || text.trim()
}

const MENTION_SPAN_RE = /<span\b[^>]*\bdata-type="mention"[^>]*>/gi
const MENTION_ID_RE = /\bdata-id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i

// User ids @mentioned in a sanitized note body, deduped. Only well-formed
// uuids in mention spans count — anything else is markup noise, not a
// recipient.
export function inboxExtractMentionIds(sanitizedHtml: string): string[] {
  const ids = new Set<string>()
  for (const tag of sanitizedHtml.match(MENTION_SPAN_RE) ?? []) {
    const m = MENTION_ID_RE.exec(tag)
    if (m?.[1]) ids.add(m[1].toLowerCase())
  }
  return [...ids]
}
