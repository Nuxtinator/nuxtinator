// A record linked to a user account (`records_entries.user_id`) takes its name and
// email addresses from that account: the person changes them there and the
// host app copies them onto the record, so CRM edits to them are refused.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { getRecordTypeFields, type RecordsPatchGuard } from '#records/server'
import { ACCOUNT_OWNED_CHANNEL_TYPES } from '#crm'

type Tx = Transaction<Database>

// The channel types a record's detail shows read-only.
export function accountOwnedChannelTypes(userId: string | null): string[] {
  return userId ? [...ACCOUNT_OWNED_CHANNEL_TYPES] : []
}

export async function linkedUserOf(tx: Tx, recordId: string): Promise<string | null> {
  const row = await tx.selectFrom('records_entries').select('user_id').where('id', '=', recordId).executeTakeFirst()
  return row?.user_id ?? null
}

// The record PATCH route's check: refuses a patch that renames a linked
// record or touches its account-owned addresses. It lives in the route, not in
// applyFieldPatch, so the host can still copy the account's values on.
export async function assertPatchKeepsAccountFields(tx: Tx, typeKey: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
  const row = await tx.selectFrom('records_entries').select(['user_id', 'name']).where('id', '=', recordId).executeTakeFirst()
  if (!row?.user_id) return
  const defs = new Map((await getRecordTypeFields(tx, typeKey)).map(d => [d.key, d]))
  for (const [key, value] of Object.entries(fields)) {
    const def = defs.get(key)
    if (!def) continue
    if (def.storage === 'promoted' && def.column === 'name' && String(value ?? '').trim() !== row.name) {
      throw accountOwned(true)
    }
    if (def.storage === 'channels' && def.channelType && ACCOUNT_OWNED_CHANNEL_TYPES.includes(def.channelType)) {
      throw accountOwned(false)
    }
  }
}

function accountOwned(name: boolean) {
  return createError({
    statusCode: 409,
    statusMessage: name ? 'The name comes from this person\'s account. Only they can change it.' : 'This address comes from this person\'s account. Only they can change it.',
    data: { code: 'account_owned' }
  })
}

export async function assertNotAccountOwned(tx: Tx, recordId: string, what: { name?: boolean, channelType?: string | null }): Promise<void> {
  const owned = !!what.name || (!!what.channelType && ACCOUNT_OWNED_CHANNEL_TYPES.includes(what.channelType))
  if (!owned || !(await linkedUserOf(tx, recordId))) return
  throw accountOwned(!!what.name)
}

// The records PATCH route runs this through the kernel's patch guards.
export const accountLinkPatchGuard: RecordsPatchGuard = async (tx, { typeKey, recordId, fields }) => {
  await assertPatchKeepsAccountFields(tx, typeKey, recordId, fields)
}
