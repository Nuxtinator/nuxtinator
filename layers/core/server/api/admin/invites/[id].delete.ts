import { getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'

// Host admin: revoke an unaccepted invite. Its link stops working.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Invite id is required' })

  const res = await db
    .deleteFrom('invites')
    .where('id', '=', id)
    .where('accepted_at', 'is', null)
    .executeTakeFirst()
  if (Number(res.numDeletedRows) === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Invite not found' })
  }

  await logEvent({
    eventType: 'invite_revoked',
    tableName: 'invites',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })
  return { success: true }
})
