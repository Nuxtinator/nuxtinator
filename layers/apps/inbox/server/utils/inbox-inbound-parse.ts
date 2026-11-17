// Header-based helpers for inbound mail (the mail kernel parses the MIME).
//
// The `From` header is never trusted on its own: the receiving provider's
// Authentication-Results decide whether a message is authenticated (DMARC
// passes, or DKIM passes and aligns with the From domain), which gates
// side effects like channel ownership verification and courtesy replies.

export interface InboxInboundHeaders {
  get(name: string): string | null
  getAll(name: string): string[]
}

// Extract the bare email address from a `From`-style header value.
export function inboxExtractEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null
  const angle = value.match(/<([^>]+)>/)
  const bare = (angle ? angle[1]! : value).trim().toLowerCase()
  const match = bare.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/)
  return match ? match[0] : null
}

// Extract a display name from a `From`-style header value (everything before
// the angle brackets).
export function inboxExtractDisplayName(value: string | null | undefined): string | null {
  if (!value) return null
  const angle = value.match(/^\s*"?([^"<]*?)"?\s*</)
  const name = angle?.[1]?.trim()
  return name || null
}

function domainOf(email: string | null): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  return at === -1 ? null : email.slice(at + 1).toLowerCase()
}

function domainsAlign(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // Relaxed alignment: organizational-domain match either direction.
  return a.endsWith('.' + b) || b.endsWith('.' + a)
}

// Determine inbound authentication from forwarded headers.
//
// DMARC pass is the authoritative "sender controls the From domain" verdict —
// it succeeds via aligned DKIM *or* aligned SPF, so it covers hosted domains
// without custom DKIM (signed d=*.gappssmtp.com, which never aligns). Fall
// back to DKIM-alignment for senders that publish no DMARC policy but sign
// with a key aligned to the From domain.
export function inboxParseAuthentication(
  headers: InboxInboundHeaders,
  fromEmail: string | null
): { authenticated: boolean, authResult: string | null } {
  const authResults = headers.getAll('authentication-results').join('; ') || null
  const fromDomain = domainOf(fromEmail)

  if (!authResults) {
    return { authenticated: false, authResult: null }
  }

  const lower = authResults.toLowerCase()
  const dkimPass = /dkim=pass/.test(lower)
  const dmarcPass = /dmarc=pass/.test(lower)

  // The signing domain comes from `header.d=` or `header.i=@domain`.
  let dkimDomain: string | null = null
  const dMatch = lower.match(/header\.d=([a-z0-9.-]+)/)
  if (dMatch) dkimDomain = dMatch[1]!
  if (!dkimDomain) {
    const iMatch = lower.match(/header\.i=@([a-z0-9.-]+)/)
    if (iMatch) dkimDomain = iMatch[1]!
  }

  const authenticated = dmarcPass || (dkimPass && domainsAlign(dkimDomain, fromDomain))
  return { authenticated, authResult: authResults }
}

// Detect auto-responders / bounces so the inbox doesn't ping-pong with bots
// (suppresses auto-ack and courtesy replies).
export function inboxIsAutoResponderOrBounce(headers: InboxInboundHeaders, fromEmail: string | null): boolean {
  const autoSubmitted = headers.get('auto-submitted')
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true

  const precedence = (headers.get('precedence') || '').toLowerCase()
  if (precedence === 'bulk' || precedence === 'auto_reply' || precedence === 'list') return true

  if (headers.get('x-autoreply') || headers.get('x-autorespond')) return true

  const local = (fromEmail || '').split('@')[0]?.toLowerCase() || ''
  if (['mailer-daemon', 'no-reply', 'noreply', 'postmaster'].includes(local)) return true

  return false
}

// Detect a vacation / out-of-office auto-reply specifically — a strict subset
// of inboxIsAutoResponderOrBounce that EXCLUDES bounces and bulk/list mail.
// Used to auto-close the conversation so an OOO reply doesn't re-open it or
// ping staff. Bounces are deliberately not matched (they signal a delivery
// failure worth surfacing, and normally arrive via the delivery webhook →
// suppression, not the inbound route).
export function inboxIsVacationAutoReply(headers: InboxInboundHeaders, fromEmail: string | null): boolean {
  // System / bounce senders are never treated as a vacation reply.
  const local = (fromEmail || '').split('@')[0]?.toLowerCase() || ''
  if (['mailer-daemon', 'no-reply', 'noreply', 'postmaster'].includes(local)) return false

  // RFC 3834: vacation responders mark themselves `auto-replied`.
  // Bounces / DSNs use `auto-generated`, which is deliberately NOT matched.
  const autoSubmitted = (headers.get('auto-submitted') || '').toLowerCase()
  if (autoSubmitted === 'auto-replied') return true

  // Non-standard but common auto-reply markers.
  const precedence = (headers.get('precedence') || '').toLowerCase()
  if (precedence === 'auto_reply') return true
  if (headers.get('x-autoreply') || headers.get('x-autorespond')) return true

  return false
}
