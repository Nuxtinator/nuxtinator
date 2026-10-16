import bcrypt from 'bcrypt'
import { db } from '../../utils/database'
import { logRegisterAttempt } from '../../utils/activity-logger'
import { sendTemplateEmail } from '#email'
import { checkRateLimit, logRateLimitExceeded } from '../../utils/rate-limit'
import { readBody, getHeader, setResponseHeader } from 'h3'
import { getSiteUrl } from '../../utils/site-url'
import { createUserAccount } from '../../utils/accounts'
import { startSession, nativeTokenFields } from '../../utils/sessions'
import { useRuntimeConfig, createError } from '#imports'
import { launcherPath } from '#core/app/utils/launcher'

export default defineEventHandler(async (event) => {
  const { email, password, display_name } = await readBody(event)

  if (!email || !password || !display_name) {
    throw createError({ statusCode: 400, statusMessage: 'Email, password, and display name are required' })
  }

  if (display_name.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'Display name must be at least 2 characters long' })
  }

  // Check rate limit by IP
  const clientIp = getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const userAgent = getHeader(event, 'user-agent') || undefined
  const rateCheck = await checkRateLimit('REGISTER_ATTEMPT', 'ip', clientIp, 15 * 60 * 1000, 10)

  if (!rateCheck.allowed) {
    logRateLimitExceeded(clientIp, '/api/auth/register', userAgent)
    setResponseHeader(event, 'Retry-After', rateCheck.retryAfterSeconds!)
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many registration attempts. Please try again later.'
    })
  }

  // Log this registration attempt
  logRegisterAttempt(clientIp, userAgent)

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 12)

  // First-user check + insert run atomically inside a transaction (see
  // createUserAccount). The activity-log insert also rides on this
  // transaction so the "who got the admin role" audit row commits with the
  // user row.
  const { userId, tokenKey, isFirstUser } = await db.transaction().execute(trx =>
    createUserAccount(trx, { email, display_name, passwordHash: hashedPassword, verified: false }, userAgent)
  )

  // First user gets auto-logged-in — no verification email, session started directly.
  if (isFirstUser) {
    const tokens = await startSession(event, { id: userId, email, display_name })

    return {
      success: true,
      autoLoggedIn: true,
      requiresVerification: false,
      // Multi-tenant: first user has no orgs yet — land them on the picker,
      // where they create the first org via the host-admin endpoint. Single-
      // tenant: no orgs exist, so land on the launcher.
      redirect: useRuntimeConfig(event).public.tenancy === true ? '/orgs' : launcherPath(),
      ...nativeTokenFields(event, tokens),
      user: {
        id: userId,
        email,
        display_name,
        avatar: '',
        verified: true,
        is_admin: true,
        permissions: []
      }
    }
  }

  // Normal registration: send verification email. Any failure is logged and
  // swallowed — the account is already committed, so turning an email failure
  // into a 500 would trap the user with an account they can't re-register.
  const verificationUrl = `${getSiteUrl()}/api/auth/verify?token=${tokenKey}`

  try {
    const emailSent = await sendTemplateEmail({
      to: email,
      template: 'verification',
      data: {
        userName: display_name,
        verificationUrl
      }
    })

    if (!emailSent) {
      console.error('Failed to send verification email to:', email)
    }
  } catch (err) {
    console.error('Error sending verification email:', err)
  }

  return {
    success: true,
    autoLoggedIn: false,
    requiresVerification: true,
    message: 'Registration successful! Please check your email to verify your account.'
  }
})
