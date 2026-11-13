import { getRouterParam, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { setUploadedAvatar, uploadAvatarFromRequest } from '../../../../utils/avatar'
import { logEvent } from '../../../../utils/activity-logger'

// Uploads a new avatar (multipart field `file`) for any user.
export default defineEventHandler(async (event) => {
  const admin = await requireOperatorAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'User id is required' })
  }

  const existing = await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst()
  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const uploaded = await uploadAvatarFromRequest(event)
  await setUploadedAvatar(id, uploaded)

  await logEvent({
    eventType: 'admin_user_avatar_updated',
    tableName: 'users',
    recordId: id,
    userId: admin.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })

  return { avatar: uploaded.url }
})
