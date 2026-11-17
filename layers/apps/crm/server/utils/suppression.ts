// Delivery suppression service (hard bounces, complaints, manual blocks),
// keyed to the channel like consent. The partial unique index on (channel_id)
// WHERE cleared_at IS NULL allows exactly one active suppression per channel;
// cleared rows stay as history. The service ships ahead of its producers —
// bounce/complaint webhooks arrive with sender layers; only manual
// suppressions are user-clearable.

import type { Selectable, Transaction } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { SuppressionReason } from '../database/schema.d'

type Tx = Transaction<Database>

export type CrmSuppressionRow = Selectable<Database['crm_channel_suppressions']>

export interface SuppressInput {
  channelId: string
  reason: SuppressionReason
  detail?: string | null
  source?: string | null
  createdBy?: string | null
}

async function activeSuppression(tx: Tx, channelId: string): Promise<CrmSuppressionRow | undefined> {
  return await tx
    .selectFrom('crm_channel_suppressions')
    .selectAll()
    .where('channel_id', '=', channelId)
    .where('cleared_at', 'is', null)
    .executeTakeFirst()
}

// First-write-wins: an existing active suppression — whatever its reason —
// stands, and the incoming one is dropped. Returns the active row either way.
// The insert keeps a bare ON CONFLICT DO NOTHING as the race guard on the
// active-per-channel partial unique (no named target — the index shape
// differs between single and multi mode).
export async function suppress(tx: Tx, input: SuppressInput): Promise<CrmSuppressionRow> {
  const existing = await activeSuppression(tx, input.channelId)
  if (existing) return existing
  const inserted = await tx
    .insertInto('crm_channel_suppressions')
    .values({
      channel_id: input.channelId,
      reason: input.reason,
      detail: input.detail ?? null,
      source: input.source ?? null,
      created_by: input.createdBy ?? null
    })
    .onConflict(oc => oc.doNothing())
    .returningAll()
    .executeTakeFirst()
  if (inserted) return inserted
  // Lost the insert race — the winner's row is the active suppression.
  return (await activeSuppression(tx, input.channelId))!
}

// Only manual blocks are user-clearable; bounce/complaint suppressions are
// facts about the address and stay until a producer-side flow (or a real
// address change) resolves them. Returns true when an active row was cleared.
export async function clearSuppression(
  tx: Tx,
  _ctx: TenantContext,
  channelId: string,
  reason: SuppressionReason
): Promise<boolean> {
  if (reason !== 'manual') {
    throw createError({ statusCode: 400, statusMessage: 'Only manual suppressions can be cleared.' })
  }
  const result = await tx
    .updateTable('crm_channel_suppressions')
    .set({ cleared_at: sql`now()` })
    .where('channel_id', '=', channelId)
    .where('reason', '=', 'manual')
    .where('cleared_at', 'is', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

// Deliverability severity ordering — a complaint (recipient marked spam)
// outranks a hard bounce (dead address), which outranks a manual block.
const SUPPRESSION_SEVERITY: Record<string, number> = { manual: 0, hard_bounce: 1, complaint: 2 }

// Insert-or-refresh for repeat delivery events: the first bounce/complaint
// creates the active row; a repeat refreshes its `detail` and UPGRADES the
// reason when the new event is more severe (a complaint following a bounce
// wins), so an operator sees the current reason/detail instead of a stale first
// message. Additive to suppress()'s first-write-wins — producers that want a
// standing suppression to be immutable keep calling suppress().
export async function recordDeliverySuppression(tx: Tx, input: SuppressInput): Promise<CrmSuppressionRow> {
  const existing = await activeSuppression(tx, input.channelId)
  if (!existing) return await suppress(tx, input)
  const upgrade = (SUPPRESSION_SEVERITY[input.reason] ?? 0) > (SUPPRESSION_SEVERITY[existing.reason] ?? 0)
  if (!upgrade && (input.detail === undefined || input.detail === null)) return existing
  return await tx
    .updateTable('crm_channel_suppressions')
    .set({
      ...(upgrade ? { reason: input.reason } : {}),
      ...(input.detail !== undefined && input.detail !== null ? { detail: input.detail } : {})
    })
    .where('id', '=', existing.id)
    .returningAll()
    .executeTakeFirstOrThrow()
}

// Producer-authorized clear of ANY active suppression (bounce/complaint as well
// as manual) — the recovery path for a false-positive bounce that
// clearSuppression()'s manual-only policy blocks. Records `cleared_at`; the
// cleared row stays as history (the partial unique only covers active rows).
// Returns true when an active row was cleared.
export async function forceClearSuppression(tx: Tx, channelId: string): Promise<boolean> {
  const result = await tx
    .updateTable('crm_channel_suppressions')
    .set({ cleared_at: sql`now()` })
    .where('channel_id', '=', channelId)
    .where('cleared_at', 'is', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

// The mail kernel's own list (bounces and complaints learned from providers)
// for email channels, as rows shaped like CRM's. Applies the kernel's scope
// rule for the transaction's org.
async function kernelSuppressions(tx: Tx, channelIds: string[]): Promise<Map<string, CrmSuppressionRow>> {
  const map = new Map<string, CrmSuppressionRow>()
  if (channelIds.length === 0) return map
  const res = await sql<{ channel_id: string, id: string, reason: 'hard_bounce' | 'complaint', detail: string | null, source: string | null, created_at: Date }>`
    select distinct on (c.id) c.id as channel_id, s.id, s.reason, s.detail, s.source, s.created_at
    from crm_channels c
    join mail_suppressions s
      on s.address_hash = encode(sha256(convert_to(lower(btrim(c.normalized_value)), 'UTF8')), 'hex')
     and s.cleared_at is null
     and (s.scope = 'global'
       or (s.scope = 'org' and s.org_id = nullif(current_setting('app.current_org', true), '')::uuid)
       or (s.scope = 'host' and nullif(current_setting('app.current_org', true), '') is null))
    where c.id in (${sql.join(channelIds)}) and c.channel_type = 'email'
    order by c.id, (s.reason = 'complaint') desc
  `.execute(tx)
  for (const r of res.rows) {
    map.set(r.channel_id, { id: r.id, channel_id: r.channel_id, reason: r.reason, detail: r.detail, source: r.source, created_by: null, created_at: r.created_at, cleared_at: null } as CrmSuppressionRow)
  }
  return map
}

// A manual block here, or a bounce or complaint on the mail kernel's list.
export async function isSuppressed(tx: Tx, channelId: string): Promise<boolean> {
  if ((await activeSuppression(tx, channelId)) !== undefined) return true
  return (await kernelSuppressions(tx, [channelId])).size > 0
}

// Batched active-suppression read for overview endpoints — absent key means
// not suppressed. CRM's own rows win over the kernel's for the same channel.
export async function getActiveSuppressions(
  tx: Tx,
  channelIds: string[]
): Promise<Map<string, CrmSuppressionRow>> {
  const map = new Map<string, CrmSuppressionRow>()
  if (channelIds.length === 0) return map
  const rows = await tx
    .selectFrom('crm_channel_suppressions')
    .selectAll()
    .where('channel_id', 'in', channelIds)
    .where('cleared_at', 'is', null)
    .execute()
  for (const row of rows) map.set(row.channel_id, row)
  const missing = channelIds.filter(id => !map.has(id))
  for (const [id, row] of await kernelSuppressions(tx, missing)) map.set(id, row)
  return map
}
