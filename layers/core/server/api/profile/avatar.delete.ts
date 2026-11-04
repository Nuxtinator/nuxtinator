import { replaceAvatar } from '../../utils/avatar'

export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  await replaceAvatar(user.userId, '')

  logEvent({
    eventType: 'PROFILE_AVATAR_REMOVED',
    tableName: 'users',
    recordId: user.userId,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })

  return { avatar: null }
})
