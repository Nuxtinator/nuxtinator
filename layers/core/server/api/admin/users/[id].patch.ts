import { readBody, getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../utils/activity-logger'

export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'User id is required' })
  }

  const body = await readBody(event)
  const rawName = typeof body?.display_name === 'string' ? body.display_name : ''
  const next = rawName.trim()

  if (next.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'Display name must be at least 2 characters' })
  }

  const existing = await db
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  if (existing.display_name !== next) {
    await db
      .updateTable('users')
      .set({ display_name: next, updated: new Date().toISOString() })
      .where('id', '=', id)
      .execute()

    await logEvent({
      eventType: 'admin_update_user',
      tableName: 'users',
      recordId: id,
      userId: admin.userId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: {
        field: 'display_name',
        from: existing.display_name,
        to: next
      }
    })
  }

  const updated = await db
    .selectFrom('users')
    .select([
      'users.id',
      'users.display_name',
      'users.email',
      'users.verified',
      'users.created',
      'users.is_admin',
      eb => eb
        .selectFrom('activity_logs')
        .select(eb2 => eb2.fn.max('activity_logs.timestamp').as('last_login'))
        .where('activity_logs.event_type', '=', 'LOGIN')
        .whereRef('activity_logs.user_id', '=', 'users.id')
        .as('last_login')
    ])
    .where('users.id', '=', id)
    .executeTakeFirst()

  if (!updated) {
    return { user: null }
  }

  const status: 'active' | 'not_verified' = updated.verified ? 'active' : 'not_verified'

  return { user: { ...updated, status } }
})
