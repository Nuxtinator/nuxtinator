// Per-org inbox settings, backed by core's shared settings store
// (core_settings + the code-owned registry). The defs are registered in
// register-inbox.ts with runtimeConfig-derived defaults; the DB holds only
// explicit per-org overrides, and RLS scopes reads to the caller's org
// through the transaction.
import { getSetting } from '#core/server/utils/settings-store'
import { urlLooksPublic } from '#core/server/utils/safe-fetch'
import type { DbClient } from '#core/server/utils/settings'

export const INBOX_SETTINGS_NAMESPACE = 'inbox'
export const INBOX_SETTING_INBOUND_DOMAIN = 'inbound_domain'
export const INBOX_SETTING_CONTACT_ADDRESS = 'contact_address'
export const INBOX_SETTING_BRAND_FROM_NAME = 'brand_from_name'
export const INBOX_SETTING_AUTO_ACK = 'auto_ack_enabled'
export const INBOX_SETTING_CONTACT_FORM_API_KEY = 'contact_form_api_key'
export const INBOX_SETTING_GROUNDING_SOURCE_URLS = 'grounding_source_urls'
export const INBOX_SETTING_NOTIFY_USER_IDS = 'notify_user_ids'
export const INBOX_SETTING_AUTO_CLOSE_DAYS = 'auto_close_days'

export const INBOX_AUTO_CLOSE_DAYS_DEFAULT = 14
export const INBOX_AUTO_CLOSE_DAYS_MAX = 365

// Coerce a stored quiet threshold into whole days. 0 disables the sweep;
// anything non-numeric falls back to the code default, out-of-range clamps.
export function sanitizeAutoCloseDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return INBOX_AUTO_CLOSE_DAYS_DEFAULT
  return Math.min(Math.max(Math.trunc(n), 0), INBOX_AUTO_CLOSE_DAYS_MAX)
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

// Whether the caller may change the inbound domain and contact address. In
// multi mode they decide which org receives a domain's mail and whose address
// replies come from, so only an operator admin (users.is_admin), who also sets
// the domain up on the mail provider, may change them. Single mode has one
// inbox, so its admins can.
export async function inboxMailIdentityEditable(tx: DbClient, ctx: { orgId: string | null, userId: string }): Promise<boolean> {
  if (!ctx.orgId) return true
  const user = await tx.selectFrom('users').select('is_admin').where('id', '=', ctx.userId).executeTakeFirst()
  return !!user?.is_admin
}

export interface InboxSettings {
  // Domain inbound mail is addressed to; matches recipient domains in the
  // webhook's org routing. One distinct (sub)domain per org.
  inboundDomain: string
  // Shared From identity and the base of contact+<token> reply addresses.
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
  const [inboundDomain, contactAddress, brandFromName, autoAckEnabled, contactFormApiKey, groundingSourceUrls, notifyUserIds, autoCloseDays] = await Promise.all([
    getSetting<string>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_INBOUND_DOMAIN),
    getSetting<string>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_CONTACT_ADDRESS),
    getSetting<string>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_BRAND_FROM_NAME),
    getSetting<boolean>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_AUTO_ACK),
    getSetting<string>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_CONTACT_FORM_API_KEY),
    getSetting<string[]>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_GROUNDING_SOURCE_URLS),
    getSetting<string[]>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_NOTIFY_USER_IDS),
    getSetting<number>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_AUTO_CLOSE_DAYS)
  ])
  return {
    inboundDomain: String(inboundDomain || '').toLowerCase(),
    contactAddress: String(contactAddress || '').toLowerCase(),
    brandFromName: String(brandFromName || '').trim(),
    autoAckEnabled: autoAckEnabled !== false,
    contactFormApiKey: String(contactFormApiKey || ''),
    groundingSourceUrls: sanitizeGroundingUrls(groundingSourceUrls),
    notifyUserIds: sanitizeInboxNotifyUserIds(notifyUserIds),
    autoCloseDays: sanitizeAutoCloseDays(autoCloseDays)
  }
}
