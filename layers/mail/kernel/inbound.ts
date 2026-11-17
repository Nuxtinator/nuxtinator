// Inbound dispatch: once per receiving recipient. Mail is only dispatched for
// an ownership-verified domain whose receiving account is the account the
// webhook arrived on. Handlers run in ascending `order`; the first that
// matches handles the recipient.
import { sql } from 'kysely'
import { parseAddress } from './address'
import type { Kernel } from './context'
import type { MailAccountRow } from './schema'
import type { InboundHandler, InboundMail, InboundOutcome } from './types'

export const PROBE_PREFIX = 'nx-probe-'

// Marks a domain's receiving role verified when its exact current probe
// address receives mail.
export function probeHandler(k: Kernel): InboundHandler {
  return {
    id: 'mail:probe',
    order: 0,
    match: ({ recipient, domain }) =>
      !!domain.probe_token && recipient.local === `${PROBE_PREFIX}${domain.probe_token}`.toLowerCase(),
    handle: async (_mail, { domain }) => {
      await k.db
        .updateTable('mail_domains')
        .set({ receive_status: 'verified', verified_at: sql`coalesce(verified_at, now())`, last_checked_at: sql`now()` })
        .where('id', '=', domain.id)
        .execute()
      return 'handled'
    }
  }
}

export interface DispatchResult {
  outcome: 'handled' | 'dropped' | 'retry'
  recipients: { address: string, outcome: InboundOutcome | 'unknown_domain' | 'unhandled', handler?: string }[]
}

export async function dispatchInbound(k: Kernel, account: MailAccountRow, mail: InboundMail): Promise<DispatchResult> {
  const handlers = [...k.inboundHandlers].sort((a, b) => a.order - b.order)
  const seen = new Set<string>()
  const result: DispatchResult = { outcome: 'dropped', recipients: [] }

  for (const rcpt of mail.envelopeTo) {
    const recipient = parseAddress(rcpt)
    if (!recipient || seen.has(recipient.address)) continue
    seen.add(recipient.address)

    const domain = await k.db
      .selectFrom('mail_domains')
      .selectAll()
      .where(sql`lower(domain)`, '=', recipient.domain)
      .where('ownership_status', '=', 'verified')
      .where('receive_account_id', '=', account.id)
      .executeTakeFirst()
    if (!domain) {
      result.recipients.push({ address: recipient.address, outcome: 'unknown_domain' })
      continue
    }

    const ctx = { recipient, domain, account, mail }
    let handled = false
    for (const handler of handlers) {
      if (!await handler.match(ctx)) continue
      const outcome = await handler.handle(mail, ctx)
      result.recipients.push({ address: recipient.address, outcome, handler: handler.id })
      handled = true
      break
    }
    if (!handled) result.recipients.push({ address: recipient.address, outcome: 'unhandled' })
  }

  if (result.recipients.some(r => r.outcome === 'retry')) result.outcome = 'retry'
  else if (result.recipients.some(r => r.outcome === 'handled')) result.outcome = 'handled'
  return result
}
