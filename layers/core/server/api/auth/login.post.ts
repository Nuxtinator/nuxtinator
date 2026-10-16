import bcrypt from 'bcrypt'
import { db } from '../../utils/database'
import { logLoginFailed, logLogin } from '../../utils/activity-logger'
import { checkRateLimit, consumeRateLimit, logRateLimitExceeded } from '../../utils/rate-limit'
import { startSession, nativeTokenFields } from '../../utils/sessions'
import { postSignInRedirect } from '../../utils/accounts'
import { readBody, getHeader, setResponseHeader } from 'h3'
import { createError } from '#imports'

export default defineEventHandler(async (event) => {
  const { email, password } = await readBody(event)

  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'Email and password are required' })
  }

  // Two limits per email: 5 failures, and 10 attempts of any outcome. The
  // attempt count is reserved atomically, so a burst of concurrent requests
  // can't all pass before their failures are logged.
  const userAgent = getHeader(event, 'user-agent') || undefined
  const attempts = await consumeRateLimit('LOGIN_ATTEMPT', 'email', email, 15 * 60 * 1000, 10)
  const rateCheck = attempts.allowed ? await checkRateLimit('LOGIN_FAILED', 'email', email, 15 * 60 * 1000, 5) : attempts

  if (!rateCheck.allowed) {
    logRateLimitExceeded(email, '/api/auth/login', userAgent)
    setResponseHeader(event, 'Retry-After', rateCheck.retryAfterSeconds!)
    throw createError({
      statusCode: 429,
      statusMessage: `Too many login attempts. Try again in ${Math.ceil(rateCheck.retryAfterSeconds! / 60)} minutes.`
    })
  }

  // Query existing user from database
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst()

  if (!user) {
    logLoginFailed(email, userAgent, { reason: 'user_not_found' })
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }

  // Accounts that sign in only through a provider have no password. Treat as
  // generic invalid credentials so we don't leak how the account signs in.
  if (user.password === null) {
    logLoginFailed(email, userAgent, { reason: 'no_password' })
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }

  // Check if user is verified
  if (!user.verified) {
    logLoginFailed(email, userAgent, { reason: 'not_verified' })
    throw createError({ statusCode: 401, statusMessage: 'Please verify your email address before logging in' })
  }

  // Verify password
  const isValidPassword = await bcrypt.compare(password, user.password)
  if (!isValidPassword) {
    logLoginFailed(email, userAgent, { reason: 'invalid_password' })
    throw createError({ statusCode: 401, statusMessage: 'Invalid credentials' })
  }

  const tokens = await startSession(event, user)

  // Log successful login
  logLogin(user.id, userAgent)

  // Login flow respects ?redirect=… on the client side; this is the default.
  const redirect = await postSignInRedirect(event, user.id)

  return {
    success: true,
    redirect,
    ...nativeTokenFields(event, tokens),
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      avatar: user.avatar,
      verified: user.verified,
      is_admin: user.is_admin ?? false,
      // Permissions are now per-org. The login response intentionally omits
      // them; clients fetch them from `/api/o/:slug` on org enter.
      permissions: []
    }
  }
})
