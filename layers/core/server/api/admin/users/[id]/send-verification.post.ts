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
    .select(['id', 'email', 'display_name', 'verified'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  if (!target.email) {
    throw createError({ statusCode: 400, statusMessage: 'This user has no email address' })
  }
  const to = target.email

  if (target.verified) {
    throw createError({ statusCode: 400, statusMessage: 'User is already verified' })
  }

  const tokenKey = randomUUID()
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await db
    .updateTable('users')
    .set({
      token_key: tokenKey,
      token_expires_at: expires.toISOString(),
      updated: new Date().toISOString()
    })
    .where('id', '=', id)
    .execute()

  const verificationUrl = `${getSiteUrl()}/api/auth/verify?token=${tokenKey}`

  const sent = await sendTemplateEmail({
    to,
    template: 'verification',
    data: {
      userName: target.display_name,
      verificationUrl
    }
  })

  if (!sent) {
    throw createError({ statusCode: 502, statusMessage: 'Failed to send verification email' })
  }

  await logEvent({
    eventType: 'admin_send_verification',
    tableName: 'users',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { email: target.email }
  })

  return { success: true }
})
