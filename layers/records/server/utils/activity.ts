// Record activity timeline reader. records_activity rows are written by
// the kernel's recordRecordsActivity (./crm-activity); this file only reads them
// back for display, resolving actor names the same way comments resolve
// authors: actor_label wins when set, else the user row's display name/email,
// else "Unknown" (actor_user_id is SET NULL when a user is deleted).
//
// Takes the caller's tenant transaction — org context (the RLS GUC in multi
// mode) exists only inside it.

import { sql } from 'kysely'
import type { SqlBool, Transaction } from 'kysely'
import { z } from 'zod'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import type { RecordsRefValue } from '#records'
import {
  clampTimelineLimit,
  decodeTimelineCursor,
  encodeTimelineCursor,
  type RecordsTimelineListOpts
} from './comments'
import { resolveClientNames } from './client-names'
import { getRecordTypeFields } from './definition-settings'
import { resolveRefValues } from './record-storage'

type Tx = Transaction<Database>

const uuidSchema = z.string().uuid()

export interface RecordsActivityItem {
  id: string
  action: string
  fieldKey: string | null
  /** Full jsonb snapshot of the field's value before the change (kind-shaped). */
  oldValue: unknown
  /** Full jsonb snapshot of the field's value after the change (kind-shaped). */
  newValue: unknown
  note: string | null
  actorUserId: string | null
  actorName: string
  /** Name of the connected app the change came through; null for the web. */
  viaClient: string | null
  createdAt: Date
}

export interface RecordsActivityPage {
  items: RecordsActivityItem[]
  nextCursor: string | null
}

/**
 * `refs` names the reader and the record's type, so ref field changes show
 * their targets as that reader sees them; without it they stay bare ids.
 */
export async function listActivity(
  tx: Tx,
  recordId: string,
  opts: RecordsTimelineListOpts = {},
  refs?: { ctx: TenantContext, typeKey: string }
): Promise<RecordsActivityPage> {
  if (!uuidSchema.safeParse(recordId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const limit = clampTimelineLimit(opts.limit)
  let qb = tx
    .selectFrom('records_activity as a')
    .leftJoin('users as u', 'u.id', 'a.actor_user_id')
    .select([
      'a.id as id',
      'a.action as action',
      'a.field_key as field_key',
      'a.old_value as old_value',
      'a.new_value as new_value',
      'a.note as note',
      'a.actor_user_id as actor_user_id',
      'a.actor_label as actor_label',
      'a.created_at as created_at',
      'a.client_id as client_id',
      'u.display_name as user_name',
      'u.email as user_email'
    ])
    .where('a.record_id', '=', recordId)
  if (opts.before) {
    const cursor = decodeTimelineCursor(opts.before)
    qb = qb.where(sql<SqlBool>`(a.created_at, a.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`)
  }
  // limit + 1: the extra row only signals that another page exists.
  const rows = await qb
    .orderBy('a.created_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(limit + 1)
    .execute()
  const page = rows.slice(0, limit)
  const clients = await resolveClientNames(tx, page.map(r => r.client_id))
  const items = page.map(r => ({
    id: r.id,
    action: r.action,
    fieldKey: r.field_key,
    oldValue: r.old_value,
    newValue: r.new_value,
    note: r.note,
    actorUserId: r.actor_user_id,
    actorName: r.actor_label ?? r.user_name ?? r.user_email ?? 'Unknown',
    viaClient: r.client_id ? clients.get(r.client_id) ?? r.client_id : null,
    createdAt: r.created_at
  }))
  if (refs) await resolveActivityRefs(tx, refs.ctx, refs.typeKey, items)
  const last = rows.length > limit ? page[page.length - 1]! : null
  return { items, nextCursor: last ? encodeTimelineCursor(last.created_at, last.id) : null }
}

// A ref change is stored as the target's id (see activityValue); the reader
// gets the target's current label, or hidden/missing.
async function resolveActivityRefs(tx: Tx, ctx: TenantContext, typeKey: string, items: RecordsActivityItem[]): Promise<void> {
  const changes = items.filter(i => i.action === 'field_changed' && i.fieldKey)
  if (changes.length === 0) return
  const sourceByKey = new Map<string, string>()
  for (const def of await getRecordTypeFields(tx, typeKey)) {
    if (def.kind === 'ref' && def.source) sourceByKey.set(def.key, def.source)
  }
  const idOf = (value: unknown): string | null => {
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id
    return null
  }
  const idsBySource = new Map<string, Set<string>>()
  for (const item of changes) {
    const source = sourceByKey.get(item.fieldKey!)
    if (!source) continue
    const ids = idsBySource.get(source) ?? new Set<string>()
    for (const value of [item.oldValue, item.newValue]) {
      const id = idOf(value)
      if (id) ids.add(id)
    }
    idsBySource.set(source, ids)
  }
  const resolved = new Map<string, Map<string, RecordsRefValue>>()
  for (const [source, ids] of idsBySource) resolved.set(source, await resolveRefValues(tx, ctx, source, [...ids]))
  for (const item of changes) {
    const values = resolved.get(sourceByKey.get(item.fieldKey!) ?? '')
    if (!values) continue
    const oldId = idOf(item.oldValue)
    const newId = idOf(item.newValue)
    item.oldValue = oldId ? values.get(oldId) ?? null : null
    item.newValue = newId ? values.get(newId) ?? null : null
  }
}
