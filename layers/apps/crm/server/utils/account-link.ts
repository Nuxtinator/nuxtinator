// A record linked to a user account (`crm_records.user_id`) takes its name and
// email addresses from that account: the person changes them there and the
// host app copies them onto the record, so CRM edits to them are refused.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'

type Tx = Transaction<Database>

export const ACCOUNT_OWNED_CHANNEL_TYPES: readonly string[] = ['email']

export async function linkedUserOf(tx: Tx, recordId: string): Promise<string | null> {
  const row = await tx.selectFrom('crm_records').select('user_id').where('id', '=', recordId).executeTakeFirst()
  return row?.user_id ?? null
}

export async function assertNotAccountOwned(tx: Tx, recordId: string, what: { name?: boolean, channelType?: string | null }): Promise<void> {
  const owned = !!what.name || (!!what.channelType && ACCOUNT_OWNED_CHANNEL_TYPES.includes(what.channelType))
  if (!owned || !(await linkedUserOf(tx, recordId))) return
  throw createError({
    statusCode: 409,
    statusMessage: what.name ? 'The name comes from this person\'s account. Only they can change it.' : 'This address comes from this person\'s account. Only they can change it.',
    data: { code: 'account_owned' }
  })
}
