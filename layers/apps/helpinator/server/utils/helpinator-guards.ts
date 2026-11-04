// Gates for the public widget API: origin allowlist, visitor session tokens,
// and abuse limits. None of these is a security boundary on its own — an
// Origin header is trivially forged outside a browser — so the rate limits and
// the per-widget daily cap are what actually bound the AI spend.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { getHeader, getRequestURL, setResponseHeader } from 'h3'
import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { db } from '#core/server/utils/database'
import { consumeRateLimit, logRateLimitExceeded } from '#core/server/utils/rate-limit'
import { getClientIp } from '#core/server/utils/client-ip'
import type { HelpinatorWidgetRow } from './helpinator-widgets'
import { helpinatorOriginAllowed } from './helpinator-origins'

type Tx = Transaction<Database>

// Per-message and per-conversation caps.
export const HELPINATOR_MAX_MESSAGE_CHARS = 2000
export const HELPINATOR_MAX_VISITOR_MESSAGES = 50

// ---------------------------------------------------------------------------
// Origins

// RFC 6761 reserves .localhost for loopback, so *.localhost matches too.
const LOOPBACK_RE = /^https?:\/\/((?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

function originOf(raw: string | undefined | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

// The visitor-reported page URL, kept only when it is a plain http(s) URL.
// It is rendered as a link in the admin app, so anything else (javascript:,
// data:, …) is dropped rather than stored.
export function helpinatorPageUrl(raw: string | undefined | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href.slice(0, 2000) : null
  } catch {
    return null
  }
}

// The embedding page's origin: the Origin header, else the Referer's origin
// (same-origin GETs carry no Origin header).
export function helpinatorRequestOrigin(event: H3Event): string | null {
  return originOf(getHeader(event, 'origin')) ?? originOf(getHeader(event, 'referer'))
}

// Allowed: an origin on the widget's list (exact or *.domain wildcard); this host itself (the admin page's
// live preview); loopback outside production so local embedding just works.
export function helpinatorAssertOrigin(event: H3Event, widget: HelpinatorWidgetRow): string {
  const origin = helpinatorRequestOrigin(event)
  if (origin) {
    if (helpinatorOriginAllowed(origin, widget.allowed_origins)) return origin
    if (origin === getRequestURL(event).origin) return origin
    const siteUrl = originOf(String(useRuntimeConfig().public.siteUrl || ''))
    if (siteUrl && origin === siteUrl) return origin
    if (process.env.NODE_ENV !== 'production' && LOOPBACK_RE.test(origin)) return origin
  }
  throw createError({ statusCode: 403, statusMessage: 'This site is not allowed to use this widget' })
}

// ---------------------------------------------------------------------------
// Visitor sessions — an opaque bearer token; only its sha256 is stored.

export function helpinatorNewSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function helpinatorHashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function helpinatorBearer(event: H3Event): string | null {
  const header = getHeader(event, 'authorization') || ''
  if (!header.toLowerCase().startsWith('bearer ')) return null
  const token = header.slice(7).trim()
  return token || null
}

// ---------------------------------------------------------------------------
// Rate limits. Keyed on an HMAC of the client IP so no raw IP is ever stored
// (the limiter counts rows in activity_logs).

export function helpinatorClientKey(event: H3Event): string {
  const ip = getClientIp(event)
  const secret = String(useRuntimeConfig().jwtSecret || 'helpinator')
  return createHmac('sha256', secret).update(`helpinator:${ip}`).digest('hex').slice(0, 32)
}

// The mailbox an address delivers to, for limiting per recipient: most
// providers ignore a `+tag` and Gmail ignores dots, so `victim+1@gmail.com`
// and `v.ictim@gmail.com` count against the same limit as `victim@gmail.com`.
// Only the limit key uses this; mail still goes to the address as typed.
export function helpinatorMailboxOf(email: string): string {
  const lower = email.trim().toLowerCase()
  const at = lower.lastIndexOf('@')
  if (at < 1) return lower
  let local = lower.slice(0, at)
  let domain = lower.slice(at + 1)
  local = local.split('+')[0] || local
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '') || local
  return `${local}@${domain}`
}

// A stable, non-reversible key for a visitor-supplied email address (per
// mailbox, see above).
export function helpinatorEmailKey(email: string): string {
  const secret = String(useRuntimeConfig().jwtSecret || 'helpinator')
  return createHmac('sha256', secret).update(`helpinator-email:${helpinatorMailboxOf(email)}`).digest('hex').slice(0, 32)
}

export async function helpinatorRateLimit(
  event: H3Event,
  action: string,
  field: string,
  value: string,
  max: number,
  windowMs: number
): Promise<void> {
  // Records and counts in one step, so parallel requests can't all pass.
  const rate = await consumeRateLimit(action, field, value, windowMs, max)
  if (!rate.allowed) {
    logRateLimitExceeded(value, event.path, getHeader(event, 'user-agent') || undefined)
    if (rate.retryAfterSeconds) setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    throw createError({ statusCode: 429, statusMessage: 'Too many requests — please wait a moment.' })
  }
}

// Visitor messages across all of a widget's conversations in the last 24h.
export async function helpinatorMessagesToday(tx: Tx, widgetId: string): Promise<number> {
  const row = await tx
    .selectFrom('helpinator_messages as m')
    .innerJoin('helpinator_conversations as c', 'c.id', 'm.conversation_id')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('c.widget_id', '=', widgetId)
    .where('m.role', '=', 'user')
    .where('m.created_at', '>', sql<Date>`now() - interval '24 hours'`)
    .executeTakeFirst()
  return row?.n ?? 0
}

// Opens a short transaction scoped to one org (no GUC in single mode). Work
// that waits on the network (model turns, embeddings, page fetches) runs
// between these instead of inside one, so it never pins a pool connection.
export type HelpinatorScope = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>

export function helpinatorScope(orgId: string | null): HelpinatorScope {
  return async fn => await db.transaction().execute(async (tx) => {
    if (orgId) await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
    return await fn(tx)
  })
}

// The org this transaction is scoped to (null in single mode) — needed for
// post-commit work that opens its own transaction.
export async function helpinatorCurrentScope(tx: Tx): Promise<string | null> {
  const res = await sql<{ org: string | null }>`select nullif(current_setting('app.current_org', true), '') as org`.execute(tx)
  return res.rows[0]?.org ?? null
}
