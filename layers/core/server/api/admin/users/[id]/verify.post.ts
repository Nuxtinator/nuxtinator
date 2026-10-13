import { getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../../utils/activity-logger'

export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'User id is required' })
  }

  const existing = await db
    .selectFrom('users')
    .select(['id', 'email', 'verified'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  if (existing.verified) {
    return { user: { id: existing.id, verified: true } }
  }

  await db
    .updateTable('users')
    .set({ verified: true, updated: new Date().toISOString() })
    .where('id', '=', id)
    .execute()

  await logEvent({
    eventType: 'admin_verify_user',
    tableName: 'users',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { email: existing.email }
  })

  return { user: { id: existing.id, verified: true } }
})
