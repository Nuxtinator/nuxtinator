import { getAuthUser } from '#core/server/utils/auth'
import { getAccountPath, withQueryParams } from '#core/server/utils/account-path'
import { hasRecentAuth } from '#core/server/utils/sessions'
import { authorizationUrl, getProviderConfig, randomToken } from '../../../../utils/social-providers'
import { safeRedirect, setFlowCookie, type SocialIntent } from '../../../../utils/social-flow'

// Begins the browser flow: remembers what the user is doing in a signed
// cookie, then sends them to the provider. Query: `intent` (login | link |
// reauth), optional `invite` token and `redirect` path. Linking needs a recent
// re-authentication; without one the user is sent back with ?link=reauth_required.
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
    if (!user) return sendRedirect(event, `/login?redirect=${encodeURIComponent(redirect || getAccountPath(event))}`)
    userId = user.userId
    sessionId = user.sid
    if (intent === 'link' && !(await hasRecentAuth(user.sid))) {
      return sendRedirect(event, withQueryParams(redirect || getAccountPath(event), { link: 'reauth_required' }))
    }
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
