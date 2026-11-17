// Sending domain resolution. For (stream, orgId) the first qualifying
// candidate wins: the org's route for the stream, the org's `*` route (only
// for orgAssignable streams), the host's route for the stream, the host's `*`
// route, then the env domain. A candidate that doesn't qualify is skipped.
import type { Kernel } from './context'
import type { MailAccountRow, MailDomainRow } from './schema'
import type { MailStream } from './types'

export interface ResolvedSender {
  domain: MailDomainRow
  account: MailAccountRow
}

export function domainQualifies(domain: MailDomainRow, stream: MailStream, purpose: 'send' | 'route' = 'send'): boolean {
  if (domain.ownership_status !== 'verified') return false
  if (purpose === 'send' && (domain.send_status !== 'verified' || !domain.send_account_id)) return false
  if (purpose === 'route' && !domain.send_account_id) return false
  if (stream.needsReceive && (domain.receive_status !== 'verified' || !domain.receive_account_id)) return false
  return true
}

export async function resolveSenderRow(k: Kernel, stream: MailStream, orgId: string | null): Promise<ResolvedSender | null> {
  const useOrg = !!orgId && stream.orgAssignable
  const routes = await k.db
    .selectFrom('mail_stream_routes')
    .innerJoin('mail_domains', 'mail_domains.id', 'mail_stream_routes.domain_id')
    .selectAll('mail_domains')
    .select(['mail_stream_routes.org_id as route_org_id', 'mail_stream_routes.stream as route_stream'])
    .where('mail_stream_routes.stream', 'in', [stream.id, '*'])
    .where(eb => useOrg
      ? eb.or([eb('mail_stream_routes.org_id', 'is', null), eb('mail_stream_routes.org_id', '=', orgId!)])
      : eb('mail_stream_routes.org_id', 'is', null))
    .execute()

  const rank = (r: { route_org_id: string | null, route_stream: string }) =>
    (r.route_org_id ? 0 : 2) + (r.route_stream === '*' ? 1 : 0)
  const candidates: MailDomainRow[] = routes
    .sort((a, b) => rank(a) - rank(b))
    .map(({ route_org_id: _o, route_stream: _s, ...domain }) => domain as MailDomainRow)

  const envDomain = await k.db
    .selectFrom('mail_domains')
    .selectAll()
    .where('source', '=', 'env')
    .where('org_id', 'is', null)
    .executeTakeFirst()
  if (envDomain) candidates.push(envDomain)

  for (const domain of candidates) {
    if (!domainQualifies(domain, stream)) continue
    const account = await k.db
      .selectFrom('mail_accounts')
      .selectAll()
      .where('id', '=', domain.send_account_id!)
      .executeTakeFirst()
    if (!account) continue
    return { domain, account }
  }
  return null
}

// The From domain: `from_domain` when a host set one, else the domain itself.
export function fromDomainOf(domain: MailDomainRow): string {
  return domain.from_domain || domain.domain
}
