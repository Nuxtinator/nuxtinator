// Consent service — the compliance side of the channel kernel. Consent is
// keyed to the channel (the address), not the record: one opt-out covers
// every record linking that address. Two stores with different lifetimes:
// crm_channel_consents holds the current state per (channel, purpose) — no
// row means unknown; crm_consent_events is the append-only proof log, written
// once per actual state change (idempotent re-grants write nothing) and built
// to outlive channel erasure via the literal value snapshot + fingerprint.

import { sql } from 'kysely'
import type { Selectable, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { ConsentEvent, ConsentStatus } from '../database/schema.d'
import { getRegisteredConsentPurposes } from './crm-registry'
import { channelFingerprint } from './normalize'
import { isSuppressed } from './suppression'

type Tx = Transaction<Database>

// Who is asserting the consent change. A TenantContext satisfies this
// structurally (routes pass ctx through); actor-less callers — webhook
// consumers like a provider's unsubscribe event — pass `{ userId: null }`
// and carry their evidence in `source`/`captureMeta` instead.
export interface CrmConsentActor {
  userId: string | null
  /** The OAuth client the change came through; recorded in the event's meta. */
  clientId?: string | null
}

type ConsentRow = Selectable<Database['crm_channel_consents']>

/** Current consent state for one (channel, purpose). */
export interface ConsentStateEntry {
  purpose: string
  status: ConsentStatus
  grantedAt: Date | null
  revokedAt: Date | null
  source: string | null
}

export interface ConsentChangeInput {
  channelId: string
  /** Must be a code-registered consent purpose (400 otherwise). */
  purpose: string
  source?: string | null
  /** Extra capture context; lands in the state row's capture_meta and the event's meta. */
  captureMeta?: Record<string, unknown>
  /** Request origin, recorded on the event row (routes pass these). */
  ip?: string | null
  userAgent?: string | null
}

export interface ConsentChangeResult {
  state: ConsentStateEntry
  /** False when the channel was already in the requested state — no event was written. */
  changed: boolean
}

/** One row of the append-only compliance log. */
export interface ConsentEventEntry {
  id: string
  purpose: string
  event: ConsentEvent
  source: string | null
  actorUserId: string | null
  occurredAt: Date
}

function toEntry(row: ConsentRow): ConsentStateEntry {
  return {
    purpose: row.purpose,
    status: row.status,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    source: row.source
  }
}

// Shared grant/revoke path: validate the purpose, no-op when the state
// already matches (idempotent — no event spam), otherwise upsert the current
// state and append one event row carrying the literal value snapshot and
// fingerprint so the proof survives channel erasure.
async function setConsent(
  tx: Tx,
  ctx: CrmConsentActor,
  status: ConsentStatus,
  input: ConsentChangeInput
): Promise<ConsentChangeResult> {
  if (!getRegisteredConsentPurposes().some(p => p.key === input.purpose)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown consent purpose: ${input.purpose}` })
  }

  const channel = await tx
    .selectFrom('crm_channels')
    .select(['id', 'channel_type', 'value', 'normalized_value'])
    .where('id', '=', input.channelId)
    .executeTakeFirst()
  if (!channel) {
    throw createError({ statusCode: 404, statusMessage: 'Channel not found.' })
  }

  const existing = await tx
    .selectFrom('crm_channel_consents')
    .selectAll()
    .where('channel_id', '=', input.channelId)
    .where('purpose', '=', input.purpose)
    .executeTakeFirst()

  if (existing && existing.status === status) {
    return { state: toEntry(existing), changed: false }
  }

  const now = new Date()
  const captureMeta: Record<string, unknown> = {
    ...(input.captureMeta ?? {}),
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent } : {})
  }
  const stateValues = {
    status,
    // Each timestamp records the most recent transition of its kind; the
    // other side is preserved as history on flip-flops.
    granted_at: status === 'opt_in' ? now : existing?.granted_at ?? null,
    revoked_at: status === 'opt_out' ? now : existing?.revoked_at ?? null,
    source: input.source ?? null,
    // ::text::jsonb — bind pre-stringified JSON as plain text so the driver
    // can't JSON-encode it a second time (same trick as the activity writer).
    capture_meta: sql<Record<string, unknown>>`${JSON.stringify(captureMeta)}::text::jsonb`
  }

  let row: ConsentRow
  if (existing) {
    row = await tx
      .updateTable('crm_channel_consents')
      .set(stateValues)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow()
  } else {
    // Bare ON CONFLICT target: the (channel_id, purpose) unique absorbs a
    // concurrent first-insert race; the loser applies its state on top.
    const inserted = await tx
      .insertInto('crm_channel_consents')
      .values({
        channel_id: input.channelId,
        purpose: input.purpose,
        ...stateValues
      })
      .onConflict(oc => oc.doNothing())
      .returningAll()
      .executeTakeFirst()
    row = inserted ?? await tx
      .updateTable('crm_channel_consents')
      .set(stateValues)
      .where('channel_id', '=', input.channelId)
      .where('purpose', '=', input.purpose)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  await tx
    .insertInto('crm_consent_events')
    .values({
      channel_id: channel.id,
      channel_value: channel.value,
      address_fingerprint: channelFingerprint(channel.channel_type, channel.normalized_value),
      purpose: input.purpose,
      event: status === 'opt_in' ? 'grant' : 'revoke',
      source: input.source ?? null,
      actor_user_id: ctx.userId,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      meta: sql<Record<string, unknown>>`${JSON.stringify({
        ...(input.captureMeta ?? {}),
        ...(ctx.clientId ? { client_id: ctx.clientId } : {})
      })}::text::jsonb`
    })
    .execute()

  return { state: toEntry(row), changed: true }
}

export async function grantConsent(
  tx: Tx,
  ctx: CrmConsentActor,
  input: ConsentChangeInput
): Promise<ConsentChangeResult> {
  return await setConsent(tx, ctx, 'opt_in', input)
}

export async function revokeConsent(
  tx: Tx,
  ctx: CrmConsentActor,
  input: ConsentChangeInput
): Promise<ConsentChangeResult> {
  return await setConsent(tx, ctx, 'opt_out', input)
}

// Batched current-state read. Every requested id gets a map entry (empty
// array = no consent captured), so callers can index without null checks.
export async function getConsentState(
  tx: Tx,
  channelIds: string[]
): Promise<Map<string, ConsentStateEntry[]>> {
  const map = new Map<string, ConsentStateEntry[]>()
  for (const id of channelIds) map.set(id, [])
  if (channelIds.length === 0) return map
  const rows = await tx
    .selectFrom('crm_channel_consents')
    .selectAll()
    .where('channel_id', 'in', channelIds)
    .orderBy('purpose', 'asc')
    .execute()
  for (const row of rows) {
    map.get(row.channel_id)?.push(toEntry(row))
  }
  return map
}

// Compliance-log page for one channel, newest first. `before` is an
// occurred_at cursor for older pages.
export async function getConsentEvents(
  tx: Tx,
  channelId: string,
  opts: { limit: number, before?: Date | string }
): Promise<ConsentEventEntry[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit), 1), 100)
  let query = tx
    .selectFrom('crm_consent_events')
    .select(['id', 'purpose', 'event', 'source', 'actor_user_id', 'occurred_at'])
    .where('channel_id', '=', channelId)
  if (opts.before !== undefined) {
    query = query.where('occurred_at', '<', opts.before instanceof Date ? opts.before : new Date(opts.before))
  }
  const rows = await query
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute()
  return rows.map(row => ({
    id: row.id,
    purpose: row.purpose,
    event: row.event,
    source: row.source,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at
  }))
}

// The single delivery gate future sender layers call: the address must be
// claimed, explicitly opted in for the purpose, and not suppressed. Takes the
// normalized value (callers normalize via normalizeChannelValue first).
export async function canSend(
  tx: Tx,
  input: { channelType: string, normalizedValue: string, purpose: string }
): Promise<boolean> {
  const channel = await tx
    .selectFrom('crm_channels')
    .select('id')
    .where('channel_type', '=', input.channelType)
    .where('normalized_value', '=', input.normalizedValue)
    .executeTakeFirst()
  if (!channel) return false
  const consent = await tx
    .selectFrom('crm_channel_consents')
    .select('status')
    .where('channel_id', '=', channel.id)
    .where('purpose', '=', input.purpose)
    .executeTakeFirst()
  if (consent?.status !== 'opt_in') return false
  return !(await isSuppressed(tx, channel.id))
}
