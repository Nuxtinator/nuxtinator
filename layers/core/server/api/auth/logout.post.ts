import { REFRESH_COOKIE, clearSessionCookies, revokeSession, sessionIdOf } from '../../utils/sessions'

// Ends this device's session. The session is found from the access token, or
// from the refresh token (cookie, or `refreshToken` in the body for native
// clients) when the access token has already expired.
export default defineEventHandler(async (event) => {
  const user = getAuthUser(event)
  const userAgent = getHeader(event, 'user-agent') || undefined

  const body = await readBody(event).catch(() => null) as { refreshToken?: unknown } | null
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : getCookie(event, REFRESH_COOKIE)
  const sessionId = user?.sid ?? (refreshToken ? sessionIdOf(refreshToken) : null)

  if (sessionId) await revokeSession(sessionId)
  clearSessionCookies(event)

  // Log logout if user was authenticated
  if (user?.userId) {
    logLogout(user.userId, userAgent)
  }

  return { success: true }
})
