import { REFRESH_COOKIE, refreshSession, setSessionCookies, clearSessionCookies, isNativeClient } from '../../utils/sessions'

// Exchanges a refresh token for a new access token. Native clients send
// `{ refreshToken }` and get the new pair back; when `refreshToken` comes back
// null they keep the one they hold. Browsers are normally refreshed by the
// session-refresh plugin, but can call this too (cookie in, cookies out).
export default defineEventHandler(async (event) => {
  const native = isNativeClient(event)
  const body = await readBody(event).catch(() => null) as { refreshToken?: unknown } | null
  const token = native
    ? (typeof body?.refreshToken === 'string' ? body.refreshToken : '')
    : getCookie(event, REFRESH_COOKIE) || ''

  const tokens = token ? await refreshSession(event, token) : null
  if (!tokens) {
    if (!native) clearSessionCookies(event)
    throw createError({ statusCode: 401, statusMessage: 'Session expired' })
  }

  if (native) return tokens
  setSessionCookies(event, tokens)
  return { success: true }
})
