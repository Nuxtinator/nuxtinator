import { getRouterParam, readBody } from 'h3'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { markCardNotificationsRead } from '../../../../utils/notify-recipients'

const ALLOWED_TYPES = ['task', 'feature', 'bug', 'artifact', 'feedback'] as const

function dateOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v === 'string') return v
  return null
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const body = await readBody(event) ?? {}

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const updates: Record<string, any> = {}

    if (typeof body.title === 'string') updates.title = body.title
    if (typeof body.post_type === 'string'
      && (ALLOWED_TYPES as readonly string[]).includes(body.post_type)) {
      updates.post_type = body.post_type
    }
    if ('description' in body) updates.description = body.description ?? null
    if ('assignee' in body) updates.assignee = body.assignee || null
    if ('priority' in body) updates.priority = body.priority || null
    if (typeof body.is_done === 'boolean') updates.is_done = body.is_done
    if ('testing_results' in body) updates.testing_results = body.testing_results ?? null
    if (body.post_meta && typeof body.post_meta === 'object') updates.post_meta = body.post_meta

    const start = dateOrNull(body.start_date)
    if (start !== undefined) updates.start_date = start
    const due = dateOrNull(body.due_date)
    if (due !== undefined) updates.due_date = due

    let movedColumn = false
    if (typeof body.column_id === 'string' && body.column_id) {
      updates.column_id = body.column_id
      movedColumn = true
    }
    if (typeof body.swimlane_id === 'string' && body.swimlane_id) {
      updates.swimlane_id = body.swimlane_id
    }

    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    updates.updated_at = sql`now()`
    if (movedColumn) updates.last_moved_at = sql`now()`

    const row = await tx
      .updateTable('cards')
      .set(updates)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()

    if (!row) throw createError({ statusCode: 404, statusMessage: 'Card not found' })

    await markCardNotificationsRead(tx, ctx.userId, id)
    logUpdate('cards', id, ctx.userId, { fields: Object.keys(updates) })
    return row
  })
})
