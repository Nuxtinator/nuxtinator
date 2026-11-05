// Schema-builder mutations over crm_channel_types: admin-created channel
// types. Collisions with code-registered channel types are rejected rather
// than merged. Validates against the merged catalog (./channel-settings), so
// uniqueness means "unique across code + DB". Org scoping is RLS through the
// caller's tenant transaction.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { RECORDS_SCHEMA_SLUG_RE } from '#records/server'
import { getChannelType, getChannelTypes, type CrmChannelTypeSetting } from './channel-settings'
import type { ChannelValueFormat } from '../database/schema.d'

type Tx = Transaction<Database>

// The five code-owned channel value formats (mirrored by the CHECK constraint
// on crm_channel_types.value_format).
export const CRM_CHANNEL_VALUE_FORMATS = ['email', 'phone', 'handle', 'url', 'freeform'] as const

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

export interface CreateChannelTypeInput {
  typeKey: string
  label: string
  valueFormat: ChannelValueFormat
  icon?: string
}

export async function createChannelType(
  tx: Tx,
  _ctx: TenantContext,
  input: CreateChannelTypeInput
): Promise<CrmChannelTypeSetting> {
  if (!RECORDS_SCHEMA_SLUG_RE.test(input.typeKey)) {
    bad('Channel type key must be a slug: [a-z][a-z0-9_]{1,40}')
  }
  if (!(CRM_CHANNEL_VALUE_FORMATS as readonly string[]).includes(input.valueFormat)) {
    bad(`Unknown value format: ${input.valueFormat}`)
  }
  const existing = await getChannelTypes(tx)
  if (existing.some(t => t.typeKey === input.typeKey)) {
    conflict(`Channel type '${input.typeKey}' already exists`)
  }
  await tx
    .insertInto('crm_channel_types')
    .values({
      type_key: input.typeKey,
      label: input.label,
      value_format: input.valueFormat,
      // The table has no icon column; admin-chosen icons ride in config and
      // read endpoints surface config.icon for custom channel types.
      config: sql<Record<string, unknown>>`${JSON.stringify(input.icon ? { icon: input.icon } : {})}::text::jsonb`
    })
    .execute()
  return (await getChannelType(tx, input.typeKey))!
}

export async function removeChannelType(
  tx: Tx,
  _ctx: TenantContext,
  typeKey: string
): Promise<void> {
  const type = await getChannelType(tx, typeKey)
  if (!type) throw createError({ statusCode: 404, statusMessage: `Unknown channel type: ${typeKey}` })
  // Code-registered channel types are code facts — a row under the same key
  // could only be a label override, so there is nothing deletable.
  if (!type.custom) bad('Code-registered channel types cannot be deleted')
  // Claimed addresses of this type carry consent/suppression history; the
  // type stays until those channel rows are gone.
  const row = await tx
    .selectFrom('crm_channels')
    .select(eb => eb.fn.countAll().as('total'))
    .where('channel_type', '=', typeKey)
    .executeTakeFirst()
  const total = Number(row?.total ?? 0)
  if (total > 0) {
    conflict(`Cannot delete '${typeKey}': ${total} channel${total === 1 ? '' : 's'} of this type exist`)
  }
  await tx.deleteFrom('crm_channel_types').where('type_key', '=', typeKey).execute()
}
