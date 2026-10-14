import { getHeader } from 'h3'
import { startSession, markReauthenticated } from '#core/server/utils/sessions'
import { postSignInRedirect } from '#core/server/utils/accounts'
import { getAccountPath, withQueryParams } from '#core/server/utils/account-path'
import { logEvent } from '#core/server/utils/activity-logger'
import { db } from '#core/server/utils/database'
import { exchangeCode, getProviderConfig, verifyIdToken } from '../../../../utils/social-providers'
import { setPendingSignup, takeFlowCookie, type SocialFlow } from '../../../../utils/social-flow'
import { completeSocialSignIn, encryptRefreshToken, type SignInErrorCode } from '../../../../utils/social-signin'

// Where the provider sends the browser back. Verifies the flow, exchanges the
// code, and signs in / links / steps up according to the flow's intent.
export default defineEventHandler(async (event) => {
  const cfg = getProviderConfig(getRouterParam(event, 'provider') || '')
  const flow = takeFlowCookie(event)
  const query = getQuery(event)
  const accountPath = getAccountPath(event)

  const fail = (code: SignInErrorCode | 'cancelled', f: SocialFlow | null = flow) => {
    if (f?.intent === 'link' || f?.intent === 'reauth') {
      return sendRedirect(event, withQueryParams(f.redirect || accountPath, { link: code }))
    }
    if (f?.invite) {
      return sendRedirect(event, `/accept-invite?token=${encodeURIComponent(f.invite)}&auth_error=${code}`)
    }
    return sendRedirect(event, `/login?auth_error=${code}`)
  }

  if (!cfg?.webEnabled || !flow || flow.provider !== cfg.id) return fail('failed')
  if (typeof query.error === 'string') return fail(query.error === 'access_denied' || query.error === 'user_cancelled_authorize' ? 'cancelled' : 'failed')
  if (query.state !== flow.state || typeof query.code !== 'string') return fail('failed')

  let profile
  let refreshToken: string | null
  try {
    const tokens = await exchangeCode(cfg, query.code, { codeVerifier: cfg.id === 'google' ? flow.codeVerifier : undefined })
    profile = await verifyIdToken(cfg, tokens.idToken, [cfg.webClientId], flow.nonce)
    refreshToken = cfg.id === 'apple' ? tokens.refreshToken : null
  } catch (err) {
    console.warn(`[social-auth] ${cfg.id} code exchange failed:`, (err as Error).message)
    return fail('failed')
  }
  if (!profile) return fail('failed')

  // Apple sends the name once, on the first authorization, outside the token.
  if (cfg.id === 'apple' && !profile.name && typeof query.user === 'string') {
    try {
      const u = JSON.parse(query.user) as { name?: { firstName?: string, lastName?: string } }
      const name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ').trim()
      if (name.length >= 2) profile.name = name
    } catch {
      // Malformed `user` payload: carry on without a name.
    }
  }

  const userAgent = getHeader(event, 'user-agent') || undefined
  const refreshTokenEnc = encryptRefreshToken(refreshToken)
  const outcome = await completeSocialSignIn({
    provider: cfg.id,
    profile,
    intent: flow.intent,
    userId: flow.userId,
    invite: flow.invite,
    clientId: cfg.webClientId,
    refreshTokenEnc,
    userAgent
  }).catch((err) => {
    console.warn(`[social-auth] ${cfg.id} sign-in failed:`, (err as Error).message)
    return { kind: 'error' as const, code: 'failed' as const }
  })

  switch (outcome.kind) {
    case 'error':
      return fail(outcome.code)

    case 'needs_name':
      setPendingSignup(event, {
        provider: cfg.id,
        profile,
        invite: flow.invite,
        redirect: flow.redirect,
        clientId: cfg.webClientId,
        refreshTokenEnc
      })
      return sendRedirect(event, '/social-auth/complete')

    case 'linked':
      return sendRedirect(event, withQueryParams(flow.redirect || accountPath, { link: 'success' }))

    case 'reauthed':
      if (flow.sessionId) await markReauthenticated(flow.sessionId)
      return sendRedirect(event, flow.redirect || accountPath)

    case 'signed_in': {
      const user = await db.selectFrom('users').select(['id', 'email', 'display_name']).where('id', '=', outcome.userId).executeTakeFirstOrThrow()
      await startSession(event, user)
      logEvent({ eventType: 'LOGIN', userId: user.id, userAgent, metadata: { via: cfg.id } })

      // An existing account opening an invite confirms joining on the invite page.
      if (flow.invite && !outcome.inviteAccepted) {
        return sendRedirect(event, `/accept-invite?token=${encodeURIComponent(flow.invite)}`)
      }
      return sendRedirect(event, flow.redirect || await postSignInRedirect(event, user.id))
    }
  }
})

