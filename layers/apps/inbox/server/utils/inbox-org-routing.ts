// Org-scope plumbing for the inbox's session-less code paths (webhooks, the
// send sweep). Same pattern as core's notification jobs: iterate org scopes
// and open a transaction per scope with the RLS GUC set via set_config.
// `[null]` in single mode (no GUC). This is the ONLY inbox code that imports
// `db` — every kernel-style function takes the transaction these helpers
// open.
//
// The per-org iteration is O(orgs) per sweep/webhook; fine at current scale.
// If org count grows large, replace with NOTIFY/LISTEN or a non-RLS routing
// table.
import { sql, type Transaction } from 'kysely'
import { db } from '#core/server/utils/database'
import { withAdvisoryLock } from '#core/server/utils/advisory-lock'
import type { Database } from '#core/server/database/schema'
import { isAppEnabledForCurrentOrg } from '#tenant/server'
import { getInboxSettings, inboxSharedDomain } from './inbox-settings'
import { INBOX_RESERVED_LOCAL_PARTS } from './inbox-identities'
import type { InboxParsedRecipient } from './inbox-addressing'

function isTenancyMode(): boolean {
  try {
    const cfg = useRuntimeConfig()
    const paths = (cfg.tenancyMigrationPaths as string[] | undefined) ?? []
    return paths.length > 0
  } catch {
    return false
  }
}

// The set of org scopes a sweep must visit. `[null]` in single mode (no
// GUC); one entry per org in multi mode. `activeOnly` skips suspended orgs,
// for sweeps that would spend money on them (fetches, embeddings).
export async function inboxListOrgScopes(opts: { activeOnly?: boolean } = {}): Promise<(string | null)[]> {
  if (!isTenancyMode()) return [null]
  // Raw SQL — `orgs` is a tenancy-only table not in core's Kysely schema.
  const res = opts.activeOnly
    ? await sql<{ id: string }>`select id from orgs where suspended_at is null`.execute(db)
    : await sql<{ id: string }>`select id from orgs`.execute(db)
  return res.rows.map(r => r.id)
}

export async function inboxWithScopeTx<T>(
  orgId: string | null,
  fn: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return await db.transaction().execute(async (tx) => {
    if (orgId) {
      await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
    }
    return await fn(tx)
  })
}

// Cross-replica gate: only one process per cluster runs the send sweep. The
// lock is session-scoped, so a crash releases it automatically. The key is a
// committed constant — don't change it without coordinating across
// deployments, and keep it distinct from core's 84100723915584200xx family.
export const INBOX_SEND_SWEEP_LOCK_KEY = '7203914082716530041'

// See core's withAdvisoryLock for the anchor connection and its idle timeout.
// Losing the lock mid-run only risks an overlapping sweep, which per-message
// claims already make safe, so the default 5-minute allowance suits the inbox.
export async function inboxWithAdvisoryLock(
  key: string,
  label: string,
  fn: () => Promise<void>,
  staleAfterMs?: number
): Promise<void> {
  await withAdvisoryLock(key, { scope: 'inbox', label, staleAfterMs }, fn)
}

// Resolve which org's inbox a tokenless inbound recipient belongs to. On the
// shared slug-address domain it is the org whose slug is the local part (one
// lookup; anything else there is unroutable). Elsewhere the recipient domain
// is matched against each org scope's inbound-domain setting. Returns the
// matching scope (null = single-mode/no-org scope), or undefined when no
// scope — or more than one — matches. Ambiguity means two orgs claim the same
// domain, which is unsupported config: the mail is ignored with a loud log
// rather than guessed at.
export async function inboxResolveOrgForRecipient(parsed: InboxParsedRecipient): Promise<string | null | undefined> {
  const shared = inboxSharedDomain()
  if (shared && parsed.domain === shared) return await inboxResolveOrgForSlug(parsed.base, shared)

  const matches: (string | null)[] = []
  for (const scope of await inboxListOrgScopes()) {
    const settings = await inboxWithScopeTx(scope, tx => getInboxSettings(tx))
    if (settings.inboundDomain && settings.inboundDomain === parsed.domain) {
      matches.push(scope)
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    console.error(`[inbox] recipient domain "${parsed.domain}" matches ${matches.length} org scopes — shared inbound domains are unsupported; ignoring the message`)
  }
  return undefined
}

// The org with this slug on the shared domain, if its inbox is on. Reserved
// local parts and the platform's own contact address never route to an org.
async function inboxResolveOrgForSlug(slug: string, shared: string): Promise<string | undefined> {
  const platformContact = String(useRuntimeConfig().inboxContactAddress || '').toLowerCase()
  if (INBOX_RESERVED_LOCAL_PARTS.includes(slug) || platformContact === `${slug}@${shared}`) return undefined
  const res = await sql<{ id: string }>`select id from orgs where slug = ${slug}`.execute(db)
  const orgId = res.rows[0]?.id
  if (!orgId) return undefined
  const enabled = await inboxWithScopeTx(orgId, tx => isAppEnabledForCurrentOrg(tx, 'inbox'))
  return enabled ? orgId : undefined
}

// Whether an org scope other than `orgId` already routes mail for `domain`.
// The shared slug-address domain belongs to the platform, so no org claims it.
export async function inboxDomainClaimedElsewhere(domain: string, orgId: string | null): Promise<boolean> {
  const wanted = domain.toLowerCase()
  if (wanted === inboxSharedDomain()) return false
  for (const scope of await inboxListOrgScopes()) {
    if (scope === orgId) continue
    const settings = await inboxWithScopeTx(scope, tx => getInboxSettings(tx))
    if (settings.inboundDomain === wanted) return true
  }
  return false
}

// Resolve which org a contact-form submission belongs to by matching the
// presented API key against each scope's `contact_form_api_key` setting. Same
// scope-scan shape as domain routing; returns undefined when no scope (or more
// than one) matches, so an unknown/duplicate key is rejected rather than
// guessed. An empty key never matches (the form is disabled by default).
export async function inboxResolveOrgForApiKey(key: string): Promise<string | null | undefined> {
  if (!key) return undefined
  const matches: (string | null)[] = []
  for (const scope of await inboxListOrgScopes()) {
    const settings = await inboxWithScopeTx(scope, tx => getInboxSettings(tx))
    if (settings.contactFormApiKey && settings.contactFormApiKey === key) {
      matches.push(scope)
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    console.error('[inbox] contact-form API key matches multiple org scopes — keys must be unique; ignoring the submission')
  }
  return undefined
}
