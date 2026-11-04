// Channel identity + linking service. crm_channels holds one row per distinct
// address (channel_type + normalized value) shared by every record that uses
// it; crm_contact_channels links records to channels per field. Editing a
// channel value on a record means claim-the-new + relink — a shared identity
// row is never mutated in place, because consent and suppression state hang
// off it.

import { createHash, randomBytes } from 'node:crypto'
import type { Selectable, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { getChannelType } from './definition-settings'
import { normalizeChannelValue } from './normalize'
import { recordCrmActivity } from './crm-activity'

type Tx = Transaction<Database>

export type CrmChannelRow = Selectable<Database['crm_channels']>
export type CrmChannelLinkRow = Selectable<Database['crm_contact_channels']>

// Get-or-create the identity row for an address. Validates the value against
// the channel type's format, normalizes, then races safely on the unique
// index via a bare ON CONFLICT DO NOTHING — no named conflict target, because
// the identity index is (channel_type, normalized_value) in single mode but
// org-scoped in multi mode.
export async function claimChannel(
  tx: Tx,
  input: { channelType: string, value: string }
): Promise<CrmChannelRow> {
  const type = await getChannelType(tx, input.channelType)
  if (!type) {
    throw createError({ statusCode: 400, statusMessage: `Unknown channel type: ${input.channelType}` })
  }
  const { normalized, valid } = normalizeChannelValue(type.valueFormat, input.value)
  if (!valid) {
    throw createError({ statusCode: 400, statusMessage: `${type.label}: invalid value.` })
  }
  await tx
    .insertInto('crm_channels')
    .values({
      channel_type: input.channelType,
      value: input.value.trim(),
      normalized_value: normalized
    })
    .onConflict(oc => oc.doNothing())
    .execute()
  return await tx
    .selectFrom('crm_channels')
    .selectAll()
    .where('channel_type', '=', input.channelType)
    .where('normalized_value', '=', normalized)
    .executeTakeFirstOrThrow()
}

// Read-only lookup by raw value — normalizes but never inserts. Returns null
// for unknown channel types or unclaimed addresses.
export async function findChannel(
  tx: Tx,
  input: { channelType: string, value: string }
): Promise<CrmChannelRow | null> {
  const type = await getChannelType(tx, input.channelType)
  if (!type) return null
  const { normalized } = normalizeChannelValue(type.valueFormat, input.value)
  const row = await tx
    .selectFrom('crm_channels')
    .selectAll()
    .where('channel_type', '=', input.channelType)
    .where('normalized_value', '=', normalized)
    .executeTakeFirst()
  return row ?? null
}

// Mark a channel's address ownership as proven. The only legitimate proof is
// an authenticated signal from the address itself — e.g. a DKIM/DMARC-aligned
// inbound email (sender layers call this from their inbound pipeline) or a
// consumed verification token. Delivery/bounce events must never call this:
// deliverability says nothing about ownership. Forward-only and idempotent —
// re-verifying keeps the original verified_at.
export async function markChannelVerified(tx: Tx, channelId: string): Promise<void> {
  await tx
    .updateTable('crm_channels')
    .set({ verified: true, verified_at: new Date() })
    .where('id', '=', channelId)
    .where('verified', '=', false)
    .execute()
}

function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Issue a verification token for a channel: the sha-256 hash and expiry are
// stored on the row (an earlier outstanding token is overwritten) and the raw
// token is returned for the caller to mail. Redeeming it is the only path
// that turns the token into `verified`.
export async function issueChannelVerificationToken(
  tx: Tx,
  channelId: string,
  opts: { ttlHours?: number } = {}
): Promise<string> {
  const token = randomBytes(24).toString('hex')
  const expires = new Date(Date.now() + (opts.ttlHours ?? 72) * 3_600_000)
  await tx
    .updateTable('crm_channels')
    .set({
      verification_token_hash: hashVerificationToken(token),
      verification_expires_at: expires,
      updated_at: new Date()
    })
    .where('id', '=', channelId)
    .execute()
  return token
}

// Redeem a raw verification token. A matching hash is cleared on sight
// (single use, expired or not); only an unexpired one marks the channel
// verified. Returns the channel when ownership was proven, else null. Runs
// inside the caller's scope transaction — in multi mode the row is only
// visible from its org's scope.
export async function consumeChannelVerificationToken(tx: Tx, token: string): Promise<CrmChannelRow | null> {
  const row = await tx
    .selectFrom('crm_channels')
    .selectAll()
    .where('verification_token_hash', '=', hashVerificationToken(token))
    .executeTakeFirst()
  if (!row) return null
  await tx
    .updateTable('crm_channels')
    .set({ verification_token_hash: null, verification_expires_at: null, updated_at: new Date() })
    .where('id', '=', row.id)
    .execute()
  const expires = row.verification_expires_at ? new Date(row.verification_expires_at).getTime() : 0
  if (expires < Date.now()) return null
  await markChannelVerified(tx, row.id)
  return { ...row, verified: true }
}

export interface LinkChannelOpts {
  label?: string | null
  primary?: boolean
}

// Attach a claimed channel to a record under a field. Idempotent — relinking
// an existing (record, channel, field) triple is a no-op. The link is always
// inserted non-primary; the primary flag is flipped by `setPrimary`
// (clear-then-set) so the partial unique index never collides.
export async function linkChannel(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  fieldKey: string,
  channelId: string,
  opts: LinkChannelOpts = {}
): Promise<CrmChannelLinkRow> {
  const channel = await tx
    .selectFrom('crm_channels')
    .select(['channel_type', 'value'])
    .where('id', '=', channelId)
    .executeTakeFirst()
  if (!channel) {
    throw createError({ statusCode: 404, statusMessage: 'Channel not found.' })
  }

  const maxRow = await tx
    .selectFrom('crm_contact_channels')
    .select(({ fn }) => fn.max('sort_order').as('max'))
    .where('record_id', '=', recordId)
    .where('field_key', '=', fieldKey)
    .executeTakeFirst()

  const inserted = await tx
    .insertInto('crm_contact_channels')
    .values({
      record_id: recordId,
      channel_id: channelId,
      field_key: fieldKey,
      label: opts.label ?? null,
      sort_order: (maxRow?.max ?? -1) + 1
    })
    .onConflict(oc => oc.doNothing())
    .returningAll()
    .executeTakeFirst()

  if (inserted) {
    await recordCrmActivity(tx, ctx, recordId, 'channel_linked', {
      fieldKey,
      new: { channel_id: channelId, channel_type: channel.channel_type, value: channel.value }
    })
  }

  const link = inserted ?? await tx
    .selectFrom('crm_contact_channels')
    .selectAll()
    .where('record_id', '=', recordId)
    .where('channel_id', '=', channelId)
    .where('field_key', '=', fieldKey)
    .executeTakeFirstOrThrow()

  if (opts.primary) {
    await setPrimary(tx, recordId, fieldKey, link.id)
    link.is_primary = true
  }
  return link
}

// Detach a channel link from a record. The channel identity row (and its
// consent/suppression history) stays.
export async function unlinkChannel(
  tx: Tx,
  ctx: TenantContext,
  recordId: string,
  linkId: string
): Promise<void> {
  const link = await tx
    .selectFrom('crm_contact_channels as cc')
    .innerJoin('crm_channels as ch', 'ch.id', 'cc.channel_id')
    .select([
      'cc.field_key as field_key',
      'cc.channel_id as channel_id',
      'ch.channel_type as channel_type',
      'ch.value as value'
    ])
    .where('cc.id', '=', linkId)
    .where('cc.record_id', '=', recordId)
    .executeTakeFirst()
  if (!link) {
    throw createError({ statusCode: 404, statusMessage: 'Channel link not found.' })
  }
  await tx.deleteFrom('crm_contact_channels').where('id', '=', linkId).execute()
  await recordCrmActivity(tx, ctx, recordId, 'channel_unlinked', {
    fieldKey: link.field_key,
    old: { channel_id: link.channel_id, channel_type: link.channel_type, value: link.value }
  })
}

// Make one link the primary for its field. Clear-then-set inside the caller's
// transaction: the partial unique index (record_id, field_key) WHERE
// is_primary forbids two primaries, so the old flag must drop before the new
// one lands.
export async function setPrimary(
  tx: Tx,
  recordId: string,
  fieldKey: string,
  linkId: string
): Promise<void> {
  const link = await tx
    .selectFrom('crm_contact_channels')
    .select('id')
    .where('id', '=', linkId)
    .where('record_id', '=', recordId)
    .where('field_key', '=', fieldKey)
    .executeTakeFirst()
  if (!link) {
    throw createError({ statusCode: 404, statusMessage: 'Channel link not found.' })
  }
  await tx
    .updateTable('crm_contact_channels')
    .set({ is_primary: false })
    .where('record_id', '=', recordId)
    .where('field_key', '=', fieldKey)
    .where('is_primary', '=', true)
    .execute()
  await tx
    .updateTable('crm_contact_channels')
    .set({ is_primary: true })
    .where('id', '=', linkId)
    .execute()
}
