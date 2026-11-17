// Provider events → trust rules → the suppression list → event handlers.
//
// An org holds the signing key of its own provider account, so it can post
// validly signed events about any address. Events from an org-owned account
// therefore only ever affect that org: their bounces are org-scoped, their
// complaints ignore the correlation org, their deliveries clear only that
// org's rows, and handlers see the account's org, not the event's.
import { sql } from 'kysely'
import { addressHash } from './address'
import { domainCredentials, suppressionMode, type Kernel } from './context'
import { activeSuppressions, anySuppressionRows, clearHardBounces, recordSuppression, type RecordSuppressionInput } from './suppressions'
import type { MailAccountRow, MailDomainRow, SuppressionScope } from './schema'
import type { MailEvent, MailProvider, ProviderList } from './types'

export const PROBE_STREAM = 'nx-probe'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The account's verified domain the event names, by sending domain or, for
// providers that report the From address, by from_domain when that is unambiguous.
async function sendingDomain(k: Kernel, account: MailAccountRow, event: MailEvent): Promise<MailDomainRow | null> {
  if (!event.domain) return null
  const name = event.domain.toLowerCase()
  const rows = await k.db
    .selectFrom('mail_domains')
    .selectAll()
    .where('send_account_id', '=', account.id)
    .where('ownership_status', '=', 'verified')
    .where(eb => eb.or([eb(sql`lower(domain)`, '=', name), eb(sql`lower(from_domain)`, '=', name)]))
    .execute()
  return rows.find(r => r.domain.toLowerCase() === name) ?? (rows.length === 1 ? rows[0]! : null)
}

// Which domains a release reaches: one account's, the domains a suppression
// row applies to, or the domains on accounts an org owns.
export type ReleaseReach =
  | { kind: 'account', accountId: string }
  | { kind: 'row', scope: SuppressionScope, orgId: string | null }
  | { kind: 'org_accounts', orgId: string }

export interface ReleaseTarget {
  account: MailAccountRow
  domain: MailDomainRow
  provider: MailProvider
}

// Verified sending domains in reach whose provider list is mirrored.
export async function mirroredTargets(k: Kernel, reach: ReleaseReach): Promise<ReleaseTarget[]> {
  let q = k.db.selectFrom('mail_domains').selectAll()
    .where('ownership_status', '=', 'verified')
    .where('send_account_id', 'is not', null)
  if (reach.kind === 'account') q = q.where('send_account_id', '=', reach.accountId)
  else if (reach.kind === 'org_accounts') {
    q = q.where('send_account_id', 'in', eb => eb.selectFrom('mail_accounts').select('id').where('org_id', '=', reach.orgId))
  } else if (reach.scope === 'org') q = q.where(eb => eb.or([eb('org_id', '=', reach.orgId), eb('org_id', 'is', null)]))
  else if (reach.scope === 'host') q = q.where('org_id', 'is', null)
  const domains = await q.orderBy('domain').execute()
  const ids = [...new Set(domains.map(d => d.send_account_id!))]
  const accounts = ids.length ? await k.db.selectFrom('mail_accounts').selectAll().where('id', 'in', ids).execute() : []
  const byId = new Map(accounts.map(a => [a.id, a]))
  const out: ReleaseTarget[] = []
  for (const domain of domains) {
    const account = byId.get(domain.send_account_id!)
    const provider = account?.provider ? k.providers.get(account.provider) : undefined
    if (!account || !provider?.providerSuppression.release) continue
    if (suppressionMode(k, account, domain) !== 'mirrored') continue
    out.push({ account, domain, provider })
  }
  return out
}

// Removes the address from each target's provider list. Returns the domains
// released and those whose release failed.
export async function releaseOn(k: Kernel, targets: ReleaseTarget[], address: string, list: ProviderList): Promise<{ released: string[], failed: string[] }> {
  const res = { released: [] as string[], failed: [] as string[] }
  for (const { account, domain, provider } of targets) {
    try {
      await provider.providerSuppression.release!(domainCredentials(k, account, domain), domain.domain, address, list)
      res.released.push(domain.domain)
    } catch (err) {
      k.log(`[mail] provider ${list} list release on ${domain.domain} failed: ${err instanceof Error ? err.message : err}`)
      res.failed.push(domain.domain)
    }
  }
  return res
}

// Releases on the event's domain, or on every mirrored domain of the account
// when the event names none.
async function releaseFromProvider(k: Kernel, account: MailAccountRow, domain: MailDomainRow | null, address: string, list: ProviderList): Promise<void> {
  const targets = domain
    ? (await mirroredTargets(k, { kind: 'account', accountId: account.id })).filter(t => t.domain.id === domain.id)
    : await mirroredTargets(k, { kind: 'account', accountId: account.id })
  await releaseOn(k, targets, address, list)
}

function bounceScope(account: MailAccountRow): { scope: 'global' | 'org', orgId: string | null } {
  return account.org_id ? { scope: 'org', orgId: account.org_id } : { scope: 'global', orgId: null }
}

function complaintScope(account: MailAccountRow, event: MailEvent): { scope: 'org' | 'host', orgId: string | null } {
  if (account.org_id) return { scope: 'org', orgId: account.org_id }
  return event.orgId ? { scope: 'org', orgId: event.orgId } : { scope: 'host', orgId: null }
}

// An org-scoped row for an org that no longer exists is skipped rather than
// failing the provider's whole batch on the foreign key.
async function record(k: Kernel, input: RecordSuppressionInput): Promise<void> {
  try {
    await recordSuppression(k.db, input)
  } catch (err) {
    if ((err as { code?: string }).code !== '23503') throw err
    k.log(`[mail] ${input.reason} for org ${input.orgId} skipped: the org no longer exists`)
  }
}

async function applySuppressionRules(k: Kernel, account: MailAccountRow, event: MailEvent): Promise<void> {
  const base = { address: event.recipient, detail: event.detail, source: account.provider, accountId: account.id, occurredAt: event.occurredAt }

  if ((event.type === 'bounced' || event.type === 'rejected') && event.permanent) {
    const { scope, orgId } = bounceScope(account)
    await record(k, { ...base, scope, orgId, reason: 'hard_bounce' })
    return
  }

  if (event.type === 'complained') {
    const { scope, orgId } = complaintScope(account, event)
    await record(k, { ...base, scope, orgId, reason: 'complaint' })
    // A complaint is never global, so the provider's domain-wide entry is
    // always too broad.
    await releaseFromProvider(k, account, await sendingDomain(k, account, event), event.recipient, 'complaint')
    return
  }

  if (event.type === 'delivered') {
    const cleared = await clearHardBounces(
      k.db,
      event.recipient,
      account.org_id ? { kind: 'org', orgId: account.org_id } : { kind: 'global' },
      event.occurredAt
    )
    if (cleared.length === 0) return
    // Other mirrored domains' lists may still hold the bounce.
    const delivering = await sendingDomain(k, account, event)
    const targets = await mirroredTargets(k, account.org_id ? { kind: 'org_accounts', orgId: account.org_id } : { kind: 'row', scope: 'global', orgId: null })
    await releaseOn(k, targets.filter(t => t.domain.id !== delivering?.id), event.recipient, 'bounce')
    return
  }

  if (event.type === 'dropped' && event.list) {
    const domain = await sendingDomain(k, account, event)
    if (event.list === 'unsubscribe') {
      // Consent belongs to CRM; the kernel has no unsubscribe reason.
      await releaseFromProvider(k, account, domain, event.recipient, 'unsubscribe')
      return
    }
    const reason = event.list === 'bounce' ? 'hard_bounce' : 'complaint'
    const target = reason === 'hard_bounce' ? bounceScope(account) : complaintScope(account, event)
    const applying = (await activeSuppressions(k.db, [addressHash(event.recipient)], target.orgId))
      .filter(r => r.reason === reason)
    if (applying.length > 0) return
    const known = await anySuppressionRows(k.db, event.recipient, reason)
    if (known.length === 0) {
      // Adopt the provider's list entry gradually.
      await record(k, { ...base, scope: target.scope, orgId: target.orgId, reason })
    } else {
      await releaseFromProvider(k, account, domain, event.recipient, event.list)
    }
  }
}

export async function handleEvents(k: Kernel, account: MailAccountRow, events: MailEvent[]): Promise<void> {
  for (const raw of events) {
    if (raw.stream === PROBE_STREAM) continue
    // A correlation org that isn't a uuid can't name an org.
    const orgId = account.org_id ?? (raw.orgId && UUID.test(raw.orgId) ? raw.orgId : null)
    const event: MailEvent = { ...raw, orgId }
    if (event.recipient) await applySuppressionRules(k, account, event)
    for (const handler of k.eventHandlers) {
      if (handler.stream && handler.stream !== event.stream) continue
      if (handler.types && !handler.types.includes(event.type)) continue
      await handler.handle(event, { account })
    }
  }
}
