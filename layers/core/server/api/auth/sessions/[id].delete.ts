import { revokeSession } from '../../../utils/sessions'

// Signs one of the current user's devices out. Its access token keeps working
// until it expires (at most 15 minutes); it can no longer be refreshed.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Session id is required' })

  const removed = await revokeSession(id, user.userId)
  if (!removed) throw createError({ statusCode: 404, statusMessage: 'Session not found' })

  logEvent({
    eventType: 'SESSION_REVOKED',
    tableName: 'sessions',
    recordId: id,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })
  return { success: true }
})
