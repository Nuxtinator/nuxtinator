import { randomUUID } from 'crypto'
import { getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logEvent } from '../../../../utils/activity-logger'
import { getSiteUrl } from '../../../../utils/site-url'
import { sendTemplateEmail } from '#email'

export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'User id is required' })
  }

  const target = await db
    .selectFrom('users')
    .select(['id', 'email', 'display_name'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const token = randomUUID()
  const expires = new Date(Date.now() + 60 * 60 * 1000) // 1 hour, matches forgot-password

  await db.transaction().execute(async (trx) => {
    // One live request per user — drop any prior unused/expired ones first.
    await trx
      .deleteFrom('password_reset_requests')
      .where('user_id', '=', target.id)
      .execute()

    await trx
      .insertInto('password_reset_requests')
      .values({
        user_id: target.id,
        token,
        expires,
        used: false
      })
      .execute()
  })

  const resetUrl = `${getSiteUrl()}/reset-password?token=${token}`

  const sent = await sendTemplateEmail({
    to: target.email,
    template: 'passwordReset',
    data: {
      userName: target.display_name || 'User',
      resetUrl
    }
  })

  if (!sent) {
    await db
      .deleteFrom('password_reset_requests')
      .where('token', '=', token)
      .execute()
    throw createError({ statusCode: 502, statusMessage: 'Failed to send password reset email' })
  }

  await logEvent({
    eventType: 'admin_send_password_reset',
    tableName: 'users',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { email: target.email }
  })

  return { success: true }
})
