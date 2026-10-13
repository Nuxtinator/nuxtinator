import { getAuthUser } from '#core/server/utils/auth'
import { authorizationUrl, getProviderConfig, randomToken } from '../../../../utils/social-providers'
import { safeRedirect, setFlowCookie, type SocialIntent } from '../../../../utils/social-flow'

// Begins the browser flow: remembers what the user is doing in a signed
// cookie, then sends them to the provider. Query: `intent` (login | link |
// reauth), optional `invite` token and `redirect` path.
export default defineEventHandler(async (event) => {
  const cfg = getProviderConfig(getRouterParam(event, 'provider') || '')
  if (!cfg?.webEnabled) throw createError({ statusCode: 404, statusMessage: 'Sign-in provider not available' })

  const query = getQuery(event)
  const intent: SocialIntent = query.intent === 'link' || query.intent === 'reauth' ? query.intent : 'login'
  const redirect = safeRedirect(query.redirect)
  const invite = typeof query.invite === 'string' && query.invite.length <= 200 ? query.invite : null

  let userId: string | null = null
  let sessionId: string | null = null
  if (intent !== 'login') {
    const user = getAuthUser(event)
    if (!user) return sendRedirect(event, `/login?redirect=${encodeURIComponent(redirect || '/account')}`)
    userId = user.userId
    sessionId = user.sid
  }

  const flow = {
    provider: cfg.id,
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: randomToken(),
    intent,
    invite,
    redirect,
    userId,
    sessionId
  }
  setFlowCookie(event, flow)
  return sendRedirect(event, authorizationUrl(cfg, flow))
})
