import { getHeader } from 'h3'
import { getAuthUser } from '#core/server/utils/auth'
import { startSession, nativeTokenFields, markReauthenticated } from '#core/server/utils/sessions'
import { postSignInRedirect } from '#core/server/utils/accounts'
import { logEvent } from '#core/server/utils/activity-logger'
import { checkRateLimit } from '#core/server/utils/rate-limit'
import { getClientIp } from '#core/server/utils/client-ip'
import { db } from '#core/server/utils/database'
import { exchangeCode, getProviderConfig, verifyIdToken } from '../../../utils/social-providers'
import type { SocialIntent } from '../../../utils/social-flow'
import { completeSocialSignIn, encryptRefreshToken, type SignInErrorCode } from '../../../utils/social-signin'

const ERROR_MESSAGES: Record<SignInErrorCode, string> = {
  email_unverified: 'The provider has not verified this email address',
  unverified_account: 'An unverified account already uses this email address',
  already_linked: 'This provider account is linked to a different user',
  one_per_provider: 'An account from this provider is already linked',
  registration_closed: 'Registration is closed; an invitation is required to create an account',
  invite_invalid: 'The invitation is no longer valid',
  failed: 'Sign-in failed'
}

const ERROR_STATUS: Partial<Record<SignInErrorCode, number>> = {
  failed: 401,
  registration_closed: 403,
  invite_invalid: 410
}

// Sign-in from a native app that already holds an ID token from the
// platform's Google or Apple SDK. Send with `X-Auth-Client: native` to get
// session tokens in the body.
//
// Body: { provider, idToken, nonce?, authorizationCode? (Apple, to allow
// revoking access when the account is deleted), displayName?, invite?,
// intent? (login | link | reauth; link and reauth need the Bearer token) }.
//
// 422 with `needsDisplayName` means a new account needs a name: ask the user
// and repeat the call (with a fresh ID token if the first has expired).
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
  const cfg = getProviderConfig(typeof body?.provider === 'string' ? body.provider : '')
  if (!cfg?.nativeEnabled) throw createError({ statusCode: 404, statusMessage: 'Sign-in provider not available' })

  const idToken = typeof body?.idToken === 'string' ? body.idToken : ''
  const nonce = typeof body?.nonce === 'string' && body.nonce ? body.nonce : null
  const intent: SocialIntent = body?.intent === 'link' || body?.intent === 'reauth' ? body.intent : 'login'
  const invite = typeof body?.invite === 'string' && body.invite.length <= 200 ? body.invite : null
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : null
  const userAgent = getHeader(event, 'user-agent') || undefined

  const ip = getClientIp(event)
  const rate = await checkRateLimit('SOCIAL_NATIVE_FAILED', 'ip', ip, 15 * 60 * 1000, 20)
  if (!rate.allowed) throw createError({ statusCode: 429, statusMessage: 'Too many attempts. Try again later.' })

  const profile = idToken ? await verifyIdToken(cfg, idToken, cfg.nativeAudiences, nonce) : null
  if (!profile) {
    logEvent({ eventType: 'SOCIAL_NATIVE_FAILED', userAgent, metadata: { ip, provider: cfg.id } })
    throw createError({ statusCode: 401, statusMessage: 'Invalid ID token' })
  }

  const authUser = intent === 'login' ? null : getAuthUser(event)
  if (intent !== 'login' && !authUser) throw createError({ statusCode: 401, statusMessage: 'Authentication required' })

  // Apple's native authorization code is exchanged with the app's bundle ID
  // (the token's audience) to obtain a refresh token we can later revoke.
  let refreshTokenEnc: string | null = null
  let clientId: string | null = null
  if (cfg.id === 'apple' && typeof body?.authorizationCode === 'string') {
    try {
      const aud = JSON.parse(Buffer.from(idToken.split('.')[1] || '', 'base64url').toString()).aud as string
      const tokens = await exchangeCode(cfg, body.authorizationCode, { clientId: aud, redirectUri: null })
      refreshTokenEnc = encryptRefreshToken(tokens.refreshToken)
      clientId = aud
    } catch (err) {
      console.warn('[social-auth] apple native code exchange failed:', (err as Error).message)
    }
  }

  const outcome = await completeSocialSignIn({
    provider: cfg.id,
    profile,
    intent,
    userId: authUser?.userId ?? null,
    invite,
    displayName,
    clientId,
    refreshTokenEnc,
    userAgent
  })

  switch (outcome.kind) {
    case 'error':
      throw createError({ statusCode: ERROR_STATUS[outcome.code] ?? 409, statusMessage: ERROR_MESSAGES[outcome.code], data: { code: outcome.code } })
    case 'needs_name':
      throw createError({ statusCode: 422, statusMessage: 'Display name required', data: { needsDisplayName: true } })
    case 'linked':
      return { success: true, linked: true }
    case 'reauthed':
      await markReauthenticated(authUser!.sid)
      return { success: true }
    case 'signed_in': {
      const user = await db.selectFrom('users').select(['id', 'email', 'display_name']).where('id', '=', outcome.userId).executeTakeFirstOrThrow()
      const tokens = await startSession(event, user)
      logEvent({ eventType: 'LOGIN', userId: user.id, userAgent, metadata: { via: cfg.id, client: 'native' } })
      return {
        success: true,
        created: outcome.created,
        // An existing account opened an invite: confirm with
        // POST /api/auth/accept-invite { token } using the new session.
        inviteNeedsConfirmation: !!invite && !outcome.inviteAccepted,
        redirect: await postSignInRedirect(event, user.id),
        ...nativeTokenFields(event, tokens)
      }
    }
  }
})
