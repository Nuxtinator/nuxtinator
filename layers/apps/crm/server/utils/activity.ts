// Record activity timeline reader. crm_record_activity rows are written by
// the kernel's recordCrmActivity (./crm-activity); this file only reads them
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
import {
  clampTimelineLimit,
  decodeTimelineCursor,
  encodeTimelineCursor,
  type CrmTimelineListOpts
} from './comments'
import { resolveClientNames } from './client-names'

type Tx = Transaction<Database>

const uuidSchema = z.string().uuid()

export interface CrmActivityItem {
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

export interface CrmActivityPage {
  items: CrmActivityItem[]
  nextCursor: string | null
}

export async function listActivity(
  tx: Tx,
  recordId: string,
  opts: CrmTimelineListOpts = {}
): Promise<CrmActivityPage> {
  if (!uuidSchema.safeParse(recordId).success) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found.' })
  }
  const limit = clampTimelineLimit(opts.limit)
  let qb = tx
    .selectFrom('crm_record_activity as a')
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
  const last = rows.length > limit ? page[page.length - 1]! : null
  return { items, nextCursor: last ? encodeTimelineCursor(last.created_at, last.id) : null }
}
