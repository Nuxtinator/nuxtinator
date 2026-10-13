import { revokeUserSessions } from '../../../utils/sessions'

// Signs out every device except this one.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  await revokeUserSessions(user.userId, user.sid)

  logEvent({
    eventType: 'SESSIONS_REVOKED_OTHERS',
    tableName: 'sessions',
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })
  return { success: true }
})
