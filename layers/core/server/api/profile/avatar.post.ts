import { setUploadedAvatar, uploadAvatarFromRequest } from '../../utils/avatar'

// Uploads a new avatar (multipart field `file`) to public storage.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)

  const uploaded = await uploadAvatarFromRequest(event)
  await setUploadedAvatar(user.userId, uploaded)

  logEvent({
    eventType: 'PROFILE_AVATAR_UPDATED',
    tableName: 'users',
    recordId: user.userId,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })

  return { avatar: uploaded.url }
})
