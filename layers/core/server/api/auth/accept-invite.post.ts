import bcrypt from 'bcrypt'
import { readBody, getHeader } from 'h3'
import { db, sql } from '../../utils/database'
import { logEvent, logLogin } from '../../utils/activity-logger'
import { createUserAccount, postSignInRedirect } from '../../utils/accounts'
import { acceptInvite, emitAcceptedMemberships, emitInviteAccepted, findInviteByToken, inviteState } from '../../utils/invites'
import { startSession, nativeTokenFields } from '../../utils/sessions'
import { getSiteUrl } from '../../utils/site-url'
import { sendTemplateEmail } from '#email'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Accepts an invite, in one of two ways:
//
//  - Signed in, with only `{ token }`: the invite is accepted into the current
//    account, whatever its email. This is how someone joins with an account
//    they already have (including one they just signed in to with a provider).
//  - Signed out, with `{ token, display_name, password }`: creates the account.
//    An email invite uses the invited address and the account starts verified.
//    A link invite takes `email` from the body; that address is unproven, so
//    the account must verify it before it can sign in.
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const token = typeof body?.token === 'string' ? body.token : ''
  const userAgent = getHeader(event, 'user-agent') || undefined

  if (!token) {
    throw createError({ statusCode: 400, statusMessage: 'Token is required' })
  }

  const invite = await findInviteByToken(db, token)
  if (!invite) {
    throw createError({ statusCode: 404, statusMessage: 'Invitation not found' })
  }
  const state = inviteState(invite)
  if (state === 'accepted') {
    throw createError({ statusCode: 410, statusMessage: 'Invitation has already been accepted' })
  }
  if (state === 'expired') {
    throw createError({ statusCode: 410, statusMessage: 'Invitation has expired' })
  }

  const authUser = getAuthUser(event)
  if (authUser && typeof body?.password !== 'string') {
    const memberships = await db.transaction().execute(trx => acceptInvite(trx, invite.id, authUser.userId))
    await emitAcceptedMemberships(memberships, authUser.userId, invite.invited_by)
    await emitInviteAccepted(invite.id, authUser.userId, invite.invited_by)

    await logEvent({
      eventType: 'invite_accepted',
      tableName: 'invites',
      recordId: invite.id,
      userId: authUser.userId,
      userAgent,
      metadata: { invited_email: invite.email, existing_account: true }
    })

    return { success: true, redirect: await postSignInRedirect(event, authUser.userId) }
  }

  const password = typeof body?.password === 'string' ? body.password : ''
  const display_name = typeof body?.display_name === 'string' ? body.display_name.trim() : ''

  if (password.length < 8) {
    throw createError({ statusCode: 400, statusMessage: 'Password must be at least 8 characters' })
  }
  if (display_name.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'Display name must be at least 2 characters' })
  }

  const email = invite.email ?? (typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '')
  if (!EMAIL_RE.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'A valid email is required' })
  }
  const verified = invite.email !== null

  const existing = await db.selectFrom('users').select('id').where(sql`lower(email)`, '=', email).executeTakeFirst()
  if (existing) {
    throw createError({
      statusCode: 409,
      statusMessage: 'An account with this email already exists. Sign in to accept the invitation.'
    })
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const { account, memberships } = await db.transaction().execute(async (trx) => {
    const account = await createUserAccount(trx, { email, display_name, passwordHash, verified, selfSignup: false }, userAgent)
    const memberships = await acceptInvite(trx, invite.id, account.userId)
    return { account, memberships }
  })

  const nitro = useNitroApp()
  try {
    await nitro.hooks.callHook('user.created', { userId: account.userId, email, viaInvite: true })
  } catch (err) {
    console.warn('[hook user.created] handler threw:', err)
  }
  await emitAcceptedMemberships(memberships, account.userId, invite.invited_by)
  await emitInviteAccepted(invite.id, account.userId, invite.invited_by)

  await logEvent({
    eventType: 'invite_accepted',
    tableName: 'invites',
    recordId: invite.id,
    userId: account.userId,
    userAgent,
    metadata: { invited_email: invite.email, email, existing_account: false }
  })

  if (!verified && !account.isFirstUser) {
    const verificationUrl = `${getSiteUrl()}/api/auth/verify?token=${account.tokenKey}`
    try {
      await sendTemplateEmail({
        to: email,
        template: 'verification',
        data: { userName: display_name, verificationUrl }
      })
    } catch (err) {
      console.error('Error sending verification email:', err)
    }
    return {
      success: true,
      requiresVerification: true,
      message: 'Check your email to verify your address, then sign in.'
    }
  }

  const tokens = await startSession(event, { id: account.userId, email, display_name })
  logLogin(account.userId, userAgent, { via: 'invite_accept' })

  try {
    await nitro.hooks.callHook('user.verified', { userId: account.userId, email })
  } catch (err) {
    console.warn('[hook user.verified] handler threw:', err)
  }

  return {
    success: true,
    redirect: await postSignInRedirect(event, account.userId),
    ...nativeTokenFields(event, tokens)
  }
})
