import { getHeader } from 'h3'
import { startSession } from '#core/server/utils/sessions'
import { postSignInRedirect } from '#core/server/utils/accounts'
import { logEvent } from '#core/server/utils/activity-logger'
import { db } from '#core/server/utils/database'
import { clearPendingSignup, readPendingSignup } from '../../../utils/social-flow'
import { completeSocialSignIn } from '../../../utils/social-signin'

// The "what should we call you?" step: finishes a provider sign-up that
// arrived without a usable name.
export default defineEventHandler(async (event) => {
  const pending = readPendingSignup(event)
  if (!pending) throw createError({ statusCode: 410, statusMessage: 'Sign-up session expired. Please start again.' })

  const body = await readBody(event).catch(() => null) as { display_name?: unknown } | null
  const displayName = typeof body?.display_name === 'string' ? body.display_name.trim() : ''
  if (displayName.length < 2 || displayName.length > 100) {
    throw createError({ statusCode: 400, statusMessage: 'Name must be 2–100 characters' })
  }

  const userAgent = getHeader(event, 'user-agent') || undefined
  const outcome = await completeSocialSignIn({
    provider: pending.provider,
    profile: pending.profile,
    intent: 'login',
    userId: null,
    invite: pending.invite,
    displayName,
    clientId: pending.clientId,
    refreshTokenEnc: pending.refreshTokenEnc,
    userAgent
  })
  clearPendingSignup(event)

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
