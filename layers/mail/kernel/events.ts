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
import { activeSuppressions, anySuppressionRows, clearHardBounces, recordSuppression } from './suppressions'
import type { MailAccountRow, MailDomainRow } from './schema'
import type { MailEvent, ProviderList } from './types'

export const PROBE_STREAM = 'nx-probe'

async function sendingDomain(k: Kernel, account: MailAccountRow, event: MailEvent): Promise<MailDomainRow | null> {
  if (event.domain) {
    const row = await k.db
      .selectFrom('mail_domains')
      .selectAll()
      .where(sql`lower(domain)`, '=', event.domain.toLowerCase())
      .where('send_account_id', '=', account.id)
      .where('ownership_status', '=', 'verified')
      .executeTakeFirst()
    if (row) return row
  }
  return null
}

async function releaseFromProvider(k: Kernel, account: MailAccountRow, domain: MailDomainRow | null, address: string, list: ProviderList): Promise<boolean> {
  const provider = account.provider ? k.providers.get(account.provider) : undefined
  if (!provider?.providerSuppression.release) return false
  if (suppressionMode(k, account, domain) !== 'mirrored') return false
  const domainName = domain?.domain ?? (await k.db
    .selectFrom('mail_domains').select('domain')
    .where('send_account_id', '=', account.id)
    .where('ownership_status', '=', 'verified')
    .executeTakeFirst())?.domain
  if (!domainName) return false
  try {
    await provider.providerSuppression.release(domainCredentials(k, account, domain), domainName, address, list)
    return true
  } catch (err) {
    k.log(`[mail] provider ${list} list release failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

function bounceScope(account: MailAccountRow): { scope: 'global' | 'org', orgId: string | null } {
  return account.org_id ? { scope: 'org', orgId: account.org_id } : { scope: 'global', orgId: null }
}

function complaintScope(account: MailAccountRow, event: MailEvent): { scope: 'org' | 'host', orgId: string | null } {
  if (account.org_id) return { scope: 'org', orgId: account.org_id }
  return event.orgId ? { scope: 'org', orgId: event.orgId } : { scope: 'host', orgId: null }
}

async function applySuppressionRules(k: Kernel, account: MailAccountRow, event: MailEvent): Promise<void> {
  const base = { address: event.recipient, detail: event.detail, source: account.provider, accountId: account.id, occurredAt: event.occurredAt }

  if ((event.type === 'bounced' || event.type === 'rejected') && event.permanent) {
    const { scope, orgId } = bounceScope(account)
    await recordSuppression(k.db, { ...base, scope, orgId, reason: 'hard_bounce' })
    return
  }

  if (event.type === 'complained') {
    const { scope, orgId } = complaintScope(account, event)
    await recordSuppression(k.db, { ...base, scope, orgId, reason: 'complaint' })
    // A complaint is never global, so the provider's domain-wide entry is
    // always too broad.
    await releaseFromProvider(k, account, await sendingDomain(k, account, event), event.recipient, 'complaint')
    return
  }

  if (event.type === 'delivered') {
    await clearHardBounces(
      k.db,
      event.recipient,
      account.org_id ? { kind: 'org', orgId: account.org_id } : { kind: 'global' },
      event.occurredAt
    )
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
      await recordSuppression(k.db, { ...base, scope: target.scope, orgId: target.orgId, reason })
    } else {
      await releaseFromProvider(k, account, domain, event.recipient, event.list)
    }
  }
}

export async function handleEvents(k: Kernel, account: MailAccountRow, events: MailEvent[]): Promise<void> {
  for (const raw of events) {
    if (raw.stream === PROBE_STREAM) continue
    const event: MailEvent = account.org_id ? { ...raw, orgId: account.org_id } : raw
    if (event.recipient) await applySuppressionRules(k, account, event)
    for (const handler of k.eventHandlers) {
      if (handler.stream && handler.stream !== event.stream) continue
      if (handler.types && !handler.types.includes(event.type)) continue
      await handler.handle(event, { account })
    }
  }
}
