import { getHeader } from 'h3'
import { startSession } from '#core/server/utils/sessions'
import { postSignInRedirect } from '#core/server/utils/accounts'
import { logEvent } from '#core/server/utils/activity-logger'
import { checkAccountPassword, enforceLoginRateLimit } from '#core/server/utils/password-sign-in'
import { db, sql } from '#core/server/utils/database'
import { clearPendingSignup, readPendingSignup } from '../../../utils/social-flow'
import { completeSocialSignIn, type SignInOutcome } from '../../../utils/social-signin'

// The step after the provider redirect when it couldn't finish on its own:
// a sign-up that arrived without a usable name (body: { display_name }), or a
// provider email that matches an account with a password (body: { password }).
export default defineEventHandler(async (event) => {
  const pending = readPendingSignup(event)
  if (!pending) throw createError({ statusCode: 410, statusMessage: 'Sign-up session expired. Please start again.' })

  const body = await readBody(event).catch(() => null) as { display_name?: unknown, password?: unknown } | null
  const userAgent = getHeader(event, 'user-agent') || undefined
  const signIn = (extra: { displayName?: string, passwordConfirmedFor?: string }): Promise<SignInOutcome> => completeSocialSignIn({
    provider: pending.provider,
    profile: pending.profile,
    intent: 'login',
    userId: null,
    invite: pending.invite,
    clientId: pending.clientId,
    refreshTokenEnc: pending.refreshTokenEnc,
    userAgent,
    waitUntil: promise => event.waitUntil(promise),
    ...extra
  })

  let outcome: SignInOutcome
  if (pending.step === 'password') {
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!password) throw createError({ statusCode: 400, statusMessage: 'Password is required' })
    const account = await db
      .selectFrom('users')
      .select(['id', 'email'])
      .where(sql`lower(email)`, '=', pending.profile.email ?? '')
      .$narrowType<{ email: string }>()
      .executeTakeFirst()
    if (!account) {
      clearPendingSignup(event)
      throw createError({ statusCode: 409, statusMessage: 'Could not finish signing in. Please start again.' })
    }
    await enforceLoginRateLimit(event, account.email, '/api/social-auth/complete')
    // A wrong password keeps the pending step so the user can try again.
    if (!(await checkAccountPassword(account, password, userAgent))) {
      throw createError({ statusCode: 401, statusMessage: 'Password is incorrect' })
    }
    outcome = await signIn({ passwordConfirmedFor: account.id })
  } else {
    const displayName = typeof body?.display_name === 'string' ? body.display_name.trim() : ''
    if (displayName.length < 2 || displayName.length > 100) {
      throw createError({ statusCode: 400, statusMessage: 'Name must be 2–100 characters' })
    }
    outcome = await signIn({ displayName })
  }
  clearPendingSignup(event)

  if (outcome.kind === 'error' && outcome.code === 'registration_closed') {
    throw createError({ statusCode: 403, statusMessage: 'Registration is closed. New accounts need an invitation.', data: { code: outcome.code } })
  }
  if (outcome.kind === 'error' && outcome.code === 'invite_invalid') {
    throw createError({ statusCode: 410, statusMessage: 'That invitation is no longer valid.', data: { code: outcome.code } })
  }
  if (outcome.kind !== 'signed_in') {
    throw createError({ statusCode: 409, statusMessage: 'Could not finish signing up. Please start again.' })
  }

  const user = await db.selectFrom('users').select(['id', 'email', 'display_name']).where('id', '=', outcome.userId).executeTakeFirstOrThrow()
  await startSession(event, user)
  logEvent({ eventType: 'LOGIN', userId: user.id, userAgent, metadata: { via: pending.provider } })

  const redirect = pending.invite && !outcome.inviteAccepted
    ? `/accept-invite?token=${encodeURIComponent(pending.invite)}`
    : pending.redirect || await postSignInRedirect(event, user.id)
  return { success: true, redirect }
})
