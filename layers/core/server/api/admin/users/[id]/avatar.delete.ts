import { getRouterParam, getHeader } from 'h3'
import { requireOperatorAdmin } from '#tenant/server'
import { replaceAvatar } from '../../../../utils/avatar'
import { logEvent } from '../../../../utils/activity-logger'

// Removes any user's avatar.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'User id is required' })
  }

  await replaceAvatar(id, '')

  await logEvent({
    eventType: 'admin_user_avatar_removed',
    tableName: 'users',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })

  return { avatar: null }
})
