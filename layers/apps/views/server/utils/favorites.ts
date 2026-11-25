// A person's favorite cards and card boards, listed at the top of the views
// landing page. Each person keeps their own, per org; nobody else sees them.
//
// A favorite card opens on the view it was added from with the card open (the
// address its Copy link gives); once the person can't open that view it opens
// as the record's page. A favorite board is the board of what sits under a
// record (builtin.subtasks.<id>). Favorites of records the person can't see
// stay stored but aren't listed, so they come back with the access.

import { z } from 'zod'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { visibleRecordIds } from '#records/server'
import type { ViewsFavoriteKind } from '../database/schema'
import { viewsSubtasksViewId } from '../../app/utils/views-types'
import { isBuiltInViewId, resolveBuiltInView } from './builtin-views'
import { getViewAccess } from './views'

type Tx = Transaction<Database>

/** How many favorites one person keeps in an org. */
export const VIEWS_FAVORITES_MAX = 100

export interface ViewsFavorite {
  kind: ViewsFavoriteKind
  recordId: string
  name: string
  recordType: string
  /** A card: the view it opens on, null once the caller can't open it. Null on a board. */
  viewId: string | null
  viewName: string | null
}

const uuidSchema = z.string().uuid()
const kindSchema = z.enum(['card', 'board'])

/** The favorite a route's `:kind/:recordId` names; 400 when it can't be one. */
export function parseFavoriteTarget(kind: unknown, recordId: unknown): { kind: ViewsFavoriteKind, recordId: string } {
  const k = kindSchema.safeParse(kind)
  const id = uuidSchema.safeParse(recordId)
  if (!k.success || !id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid favorite' })
  return { kind: k.data, recordId: id.data }
}

/** The name of view `viewId` when the caller can open it, else null. */
async function openViewName(tx: Tx, ctx: TenantContext, viewId: string): Promise<string | null> {
  if (isBuiltInViewId(viewId)) return (await resolveBuiltInView(tx, ctx, viewId))?.view.name ?? null
  if (!uuidSchema.safeParse(viewId).success) return null
  const view = await tx
    .selectFrom('views_definitions')
    .select(['id', 'name', 'owner_id', 'visibility', 'org_level'])
    .where('id', '=', viewId)
    .executeTakeFirst()
  return view && await getViewAccess(tx, ctx, view) ? view.name : null
}

/** The caller's favorites they can still see, oldest first. */
export async function listFavorites(tx: Tx, ctx: TenantContext): Promise<ViewsFavorite[]> {
  const rows = await tx
    .selectFrom('views_favorites as f')
    .innerJoin('records_entries as r', 'r.id', 'f.record_id')
    .select(['f.kind', 'f.record_id', 'f.view_id', 'r.name', 'r.record_type'])
    .where('f.user_id', '=', ctx.userId)
    .orderBy('f.created_at', 'asc')
    .orderBy('f.record_id', 'asc')
    .execute()
  const visible = await visibleRecordIds(tx, ctx, [...new Set(rows.map(r => r.record_id))])
  const shown = rows.filter(r => visible.has(r.record_id))
  const viewNames = new Map<string, string | null>()
  for (const row of shown) {
    if (row.view_id && !viewNames.has(row.view_id)) {
      viewNames.set(row.view_id, await openViewName(tx, ctx, row.view_id))
    }
  }
  return shown.map((row) => {
    const viewName = row.view_id ? viewNames.get(row.view_id) ?? null : null
    return {
      kind: row.kind,
      recordId: row.record_id,
      name: row.name,
      recordType: row.record_type,
      viewId: viewName === null ? null : row.view_id,
      viewName
    }
  })
}

/**
 * Makes a record a favorite of the caller's: its card, opening on `viewId`,
 * or its board. Adding a card that already is one points it at `viewId`.
 */
export async function addFavorite(
  tx: Tx,
  ctx: TenantContext,
  kind: ViewsFavoriteKind,
  recordId: string,
  viewId: string | null
): Promise<ViewsFavorite> {
  const record = await tx
    .selectFrom('records_entries')
    .select(['id', 'name', 'record_type'])
    .where('id', '=', recordId)
    .executeTakeFirst()
  if (!record || !(await visibleRecordIds(tx, ctx, [record.id])).has(record.id)) {
    throw createError({ statusCode: 404, statusMessage: 'Record not found' })
  }

  let viewName: string | null = null
  if (kind === 'board') {
    if (viewId !== null) throw createError({ statusCode: 400, statusMessage: 'A board favorite takes no view' })
    if (!(await resolveBuiltInView(tx, ctx, viewsSubtasksViewId(record.id)))) {
      throw createError({ statusCode: 404, statusMessage: 'Board not found' })
    }
  } else {
    if (viewId === null) throw createError({ statusCode: 400, statusMessage: 'A card favorite needs the view it opens on' })
    viewName = await openViewName(tx, ctx, viewId)
    if (viewName === null) throw createError({ statusCode: 404, statusMessage: 'View not found' })
  }

  const mine = tx
    .selectFrom('views_favorites')
    .where('user_id', '=', ctx.userId)
  const existing = await mine
    .select('record_id')
    .where('kind', '=', kind)
    .where('record_id', '=', record.id)
    .executeTakeFirst()
  if (existing) {
    await tx
      .updateTable('views_favorites')
      .set({ view_id: viewId })
      .where('user_id', '=', ctx.userId)
      .where('kind', '=', kind)
      .where('record_id', '=', record.id)
      .execute()
  } else {
    const { n } = await mine
      .select(eb => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow()
    if (Number(n) >= VIEWS_FAVORITES_MAX) {
      throw createError({ statusCode: 409, statusMessage: `You have ${VIEWS_FAVORITES_MAX} favorites. Remove one to add another.` })
    }
    await tx
      .insertInto('views_favorites')
      .values({ user_id: ctx.userId, kind, record_id: record.id, view_id: viewId })
      .execute()
  }

  return { kind, recordId: record.id, name: record.name, recordType: record.record_type, viewId, viewName }
}

export async function removeFavorite(tx: Tx, ctx: TenantContext, kind: ViewsFavoriteKind, recordId: string): Promise<void> {
  await tx
    .deleteFrom('views_favorites')
    .where('user_id', '=', ctx.userId)
    .where('kind', '=', kind)
    .where('record_id', '=', recordId)
    .execute()
}
