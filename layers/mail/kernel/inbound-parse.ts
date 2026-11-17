// Raw RFC 822 → InboundMail. Every provider hands the kernel the raw message,
// so there is one parser. The SMTP envelope recipients come from the
// provider; the header To is only a last resort.
import PostalMime from 'postal-mime'
import type { InboundHeaders, InboundMail } from './types'

type PostalAddress = { name: string, address?: string, group?: { name: string, address: string }[] }

function flatten(list: PostalAddress[] | undefined): string[] {
  const out: string[] = []
  for (const a of list ?? []) {
    if (a.address) out.push(a.address.toLowerCase())
    for (const g of a.group ?? []) if (g.address) out.push(g.address.toLowerCase())
  }
  return out
}

function headerMap(headers: { key: string, value: string }[]): InboundHeaders {
  const map = new Map<string, string[]>()
  for (const h of headers) {
    const key = h.key.toLowerCase()
    map.set(key, [...(map.get(key) ?? []), h.value])
  }
  return {
    get: name => map.get(name.toLowerCase())?.[0] ?? null,
    getAll: name => map.get(name.toLowerCase()) ?? []
  }
}

function domainOf(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  return at === -1 ? null : email.slice(at + 1).toLowerCase()
}

// Authentication-Results, as added by the receiving provider.
export function parseAuthenticationResults(headers: InboundHeaders): InboundMail['authentication'] {
  const all = headers.getAll('authentication-results').join('; ').toLowerCase()
  const dmarcMatch = all.match(/dmarc=(\w+)/)
  const dmarc: 'pass' | 'fail' | 'none' = dmarcMatch?.[1] === 'pass' ? 'pass' : dmarcMatch && dmarcMatch[1] !== 'none' ? 'fail' : 'none'
  const dkim: { domain: string, result: string }[] = []
  for (const m of all.matchAll(/dkim=(\w+)([^;]*)/g)) {
    const params = m[2] ?? ''
    const domain = params.match(/header\.d=([a-z0-9.-]+)/)?.[1] ?? params.match(/header\.i=@([a-z0-9.-]+)/)?.[1] ?? ''
    dkim.push({ domain, result: m[1]! })
  }
  const spf = all.match(/spf=(\w+)/)?.[1] ?? 'none'
  return { dmarc, dkim, spf }
}

export interface Envelope {
  to?: string[]
  from?: string | null
  spamScore?: number | null
}

export async function parseInbound(raw: Buffer, envelope: Envelope = {}): Promise<InboundMail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })
  const headers = headerMap(email.headers)
  const from = email.from && 'address' in email.from && email.from.address
    ? { address: email.from.address.toLowerCase(), name: email.from.name || null }
    : null
  const to = flatten(email.to as PostalAddress[] | undefined)
  const cc = flatten(email.cc as PostalAddress[] | undefined)
  const envelopeTo = (envelope.to ?? []).map(a => a.trim().toLowerCase()).filter(Boolean)

  return {
    raw,
    envelopeTo: envelopeTo.length > 0 ? envelopeTo : to,
    envelopeFrom: envelope.from ?? email.returnPath ?? null,
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: (email.references ?? '').split(/\s+/).filter(Boolean),
    from,
    to,
    cc,
    subject: email.subject ?? '',
    text: email.text ?? null,
    html: email.html ?? null,
    headers,
    attachments: email.attachments.map(a => ({
      filename: a.filename ?? 'attachment',
      contentType: a.mimeType,
      data: Buffer.from(a.content as ArrayBuffer),
      cid: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null,
      inline: a.disposition === 'inline'
    })),
    authentication: parseAuthenticationResults(headers),
    spamScore: envelope.spamScore ?? null
  }
}

// DMARC pass, or DKIM pass aligned with the From domain: the sender controls
// the From address.
export function isAuthenticated(mail: InboundMail): boolean {
  if (mail.authentication.dmarc === 'pass') return true
  const fromDomain = domainOf(mail.from?.address)
  if (!fromDomain) return false
  return mail.authentication.dkim.some(d => d.result === 'pass' && d.domain
    && (d.domain === fromDomain || d.domain.endsWith('.' + fromDomain) || fromDomain.endsWith('.' + d.domain)))
}
