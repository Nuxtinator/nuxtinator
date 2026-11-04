import { verifyToken } from '../utils/auth'
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  refreshSession,
  setSessionCookies,
  clearSessionCookies
} from '../utils/sessions'
import { cookieName } from '../utils/cookie-names'

// Browsers carry a 15-minute access cookie and a long-lived refresh cookie.
// When a request arrives with a refresh cookie but no valid access token, the
// session is rotated here, before any route handler runs, so every handler
// (including other layers' synchronous `getAuthUser` calls) sees a fresh token
// and the SPA never has to retry. Native clients refresh explicitly via
// `/api/auth/refresh` and are unaffected.
const SKIP_PREFIXES = ['/_nuxt/', '/__nuxt', '/api/auth/refresh', '/api/auth/logout']

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', async (event) => {
    const path = event.path || ''
    if (SKIP_PREFIXES.some(p => path.startsWith(p))) return

    const refreshToken = getCookie(event, cookieName(REFRESH_COOKIE))
    if (!refreshToken) return

    const access = getCookie(event, cookieName(ACCESS_COOKIE))
    if (access && verifyToken(access)) return

    const tokens = await refreshSession(event, refreshToken)
    if (!tokens) {
      clearSessionCookies(event)
      return
    }
    setSessionCookies(event, tokens)
    event.context.refreshedAccessToken = tokens.accessToken
  })
})
