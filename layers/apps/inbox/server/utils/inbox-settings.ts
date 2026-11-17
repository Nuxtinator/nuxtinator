// Per-org inbox settings, backed by core's shared settings store
// (core_settings + the code-owned registry). The defs are registered in
// register-inbox.ts with their code defaults; the DB holds only explicit
// per-org overrides, and RLS scopes reads to the caller's org through the
// transaction. The mail domain and contact address are not settings: they
// follow the domain the mail kernel resolves for the org's inbox stream.
import { sql } from 'kysely'
import { getSetting } from '#core/server/utils/settings-store'
import { urlLooksPublic } from '#core/server/utils/safe-fetch'
import { resolveMailSender } from '#core/server/utils/mail'
import type { DbClient } from '#core/server/utils/settings'

export const INBOX_SETTINGS_NAMESPACE = 'inbox'
export const INBOX_SETTING_CONTACT_LOCAL = 'contact_local'
export const INBOX_SETTING_BRAND_FROM_NAME = 'brand_from_name'
export const INBOX_SETTING_AUTO_ACK = 'auto_ack_enabled'
export const INBOX_SETTING_CONTACT_FORM_API_KEY = 'contact_form_api_key'
export const INBOX_SETTING_GROUNDING_SOURCE_URLS = 'grounding_source_urls'
export const INBOX_SETTING_NOTIFY_USER_IDS = 'notify_user_ids'
export const INBOX_SETTING_AUTO_CLOSE_DAYS = 'auto_close_days'

export const INBOX_CONTACT_LOCAL_DEFAULT = 'contact'
export const INBOX_AUTO_CLOSE_DAYS_DEFAULT = 14
export const INBOX_AUTO_CLOSE_DAYS_MAX = 365

// Coerce a stored quiet threshold into whole days. 0 disables the sweep;
// anything non-numeric falls back to the code default, out-of-range clamps.
export function sanitizeAutoCloseDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return INBOX_AUTO_CLOSE_DAYS_DEFAULT
  return Math.min(Math.max(Math.trunc(n), 0), INBOX_AUTO_CLOSE_DAYS_MAX)
}

// Local parts that are never a contact address: the VERP return path, a
// common system sender, and the kernel's own `nx-` addresses (probes).
const CONTACT_LOCAL_RESERVED = ['bounce', 'notifications']
const CONTACT_LOCAL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

// Why a contact local part is refused, or null when it's usable.
export function inboxContactLocalError(value: string): string | null {
  if (!CONTACT_LOCAL_RE.test(value)) return 'Use only letters, numbers, dots, hyphens and underscores'
  if (CONTACT_LOCAL_RESERVED.includes(value) || value.startsWith('nx-')) return `"${value}" is reserved`
  return null
}

export function sanitizeContactLocal(value: unknown): string {
  const v = String(value ?? '').trim().toLowerCase()
  return inboxContactLocalError(v) ? INBOX_CONTACT_LOCAL_DEFAULT : v
}

// Coerce a stored notify list into deduped user-id strings, preserving order.
export function sanitizeInboxNotifyUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
  }
  return out
}

// Sanitize a stored grounding-URL list: keep http(s) strings, trim, dedupe,
// preserve order.
export function sanitizeGroundingUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const url = v.trim()
    if (!/^https?:\/\//i.test(url) || !urlLooksPublic(url) || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

export interface InboxSettings {
  // The receiving domain the mail kernel resolves for this org's inbox
  // stream; '' when no domain can receive mail yet.
  mailDomain: string
  // True when the org uses the host's domain under slug addresses, where the
  // local part is the org slug and personal aliases don't apply.
  slugAddress: boolean
  // The local part of the shared address on the org's own or the host's
  // domain (not used under slug addresses).
  contactLocal: string
  // Shared From identity and the base of contact+<token> reply addresses,
  // derived from mailDomain; '' when there is none (replies are then held).
  contactAddress: string
  // Display name on shared-address sends and courtesy mail ("Acme Support").
  // Personal-alias sends carry the agent's own name instead.
  brandFromName: string
  // Whether brand-new authenticated conversations get an automatic
  // acknowledgment email.
  autoAckEnabled: boolean
  // Server-to-server key that gates the public contact-form endpoint and
  // identifies which org a submission belongs to. Empty = the form is disabled.
  contactFormApiKey: string
  // Page URLs the AI grounding sync snapshots into grounding_documents. Empty =
  // the drafter grounds only on the tone guide + knowledge base.
  groundingSourceUrls: string[]
  // Who is emailed immediately when mail lands on an unassigned conversation.
  // Everyone with inbox access still gets the bell; only these users get mail.
  // Empty = bell only, so a busy inbox never mass-mails the whole team.
  notifyUserIds: string[]
  // Days a pending conversation may sit without a contact reply before the
  // daily sweep closes it. 0 = never auto-close.
  autoCloseDays: number
}

export async function getInboxSettings(tx: DbClient): Promise<InboxSettings> {
  const [contactLocalRaw, brandFromName, autoAckEnabled, contactFormApiKey, groundingSourceUrls, notifyUserIds, autoCloseDays] = await Promise.all([
    getSetting<string>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_CONTACT_LOCAL),
    getSetting<string>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_BRAND_FROM_NAME),
    getSetting<boolean>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_AUTO_ACK),
    getSetting<string>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_CONTACT_FORM_API_KEY),
    getSetting<string[]>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_GROUNDING_SOURCE_URLS),
    getSetting<string[]>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_NOTIFY_USER_IDS),
    getSetting<number>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_AUTO_CLOSE_DAYS)
  ])
  const contactLocal = sanitizeContactLocal(contactLocalRaw)
  const identity = await inboxResolveMailIdentity(tx, contactLocal)
  return {
    ...identity,
    contactLocal,
    brandFromName: String(brandFromName || '').trim(),
    autoAckEnabled: autoAckEnabled !== false,
    contactFormApiKey: String(contactFormApiKey || ''),
    groundingSourceUrls: sanitizeGroundingUrls(groundingSourceUrls),
    notifyUserIds: sanitizeInboxNotifyUserIds(notifyUserIds),
    autoCloseDays: sanitizeAutoCloseDays(autoCloseDays)
  }
}

// Slug addresses (INBOX_SLUG_ADDRESSES=true): an org without its own
// receiving domain gets <org slug>@<host inbox domain>. Orgs only exist with
// the tenancy layer, so it needs multi mode. Read at runtime, not build time.
export function inboxSlugAddressesEnabled(): boolean {
  if (process.env.INBOX_SLUG_ADDRESSES !== 'true') return false
  try {
    return !!useRuntimeConfig().public.tenancy
  } catch {
    return false
  }
}

// The org bound to `tx` (null in single mode or the host scope).
export async function inboxCurrentOrgId(tx: DbClient): Promise<string | null> {
  const res = await sql<{ org: string | null }>`
    select nullif(current_setting('app.current_org', true), '') as org
  `.execute(tx)
  return res.rows[0]?.org ?? null
}

// The org's mail domain and contact address. The domain is the inbox
// stream's resolved `domain` (not its From domain): replies must reach a
// receiving domain. Derived on every read, so it follows domain changes and
// slug renames.
export async function inboxResolveMailIdentity(
  tx: DbClient,
  contactLocal: string
): Promise<Pick<InboxSettings, 'mailDomain' | 'slugAddress' | 'contactAddress'>> {
  const orgId = await inboxCurrentOrgId(tx)
  const sender = await resolveMailSender('inbox', orgId)
  if (!sender) return { mailDomain: '', slugAddress: false, contactAddress: '' }
  const domain = sender.domain.toLowerCase()
  if (orgId && sender.domainOrgId === null && inboxSlugAddressesEnabled()) {
    const res = await sql<{ slug: string }>`select slug from orgs where id = ${orgId}`.execute(tx)
    const slug = res.rows[0]?.slug
    return { mailDomain: domain, slugAddress: true, contactAddress: slug ? `${slug}@${domain}` : '' }
  }
  return { mailDomain: domain, slugAddress: false, contactAddress: `${contactLocal}@${domain}` }
}

// The settings shape the settings endpoints return.
export function inboxSettingsView(s: InboxSettings) {
  return {
    mailDomain: s.mailDomain,
    slugAddress: s.slugAddress,
    contactLocal: s.contactLocal,
    contactAddress: s.contactAddress,
    noReceivingDomain: !s.mailDomain,
    brandFromName: s.brandFromName,
    autoAckEnabled: s.autoAckEnabled,
    contactFormApiKey: s.contactFormApiKey,
    groundingSourceUrls: s.groundingSourceUrls,
    notifyUserIds: s.notifyUserIds,
    autoCloseDays: s.autoCloseDays
  }
}
