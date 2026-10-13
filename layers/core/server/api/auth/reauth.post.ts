import bcrypt from 'bcrypt'
import { db } from '../../utils/database'
import { checkRateLimit, logRateLimitExceeded } from '../../utils/rate-limit'
import { markReauthenticated } from '../../utils/sessions'

// Step-up with the account password: marks this session as recently
// authenticated so sensitive endpoints accept it for the next few minutes.
// Provider-only accounts step up by signing in with their provider instead.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const userAgent = getHeader(event, 'user-agent') || undefined
  const body = await readBody(event).catch(() => null) as { password?: unknown } | null
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!password) {
    throw createError({ statusCode: 400, statusMessage: 'Password is required' })
  }

  const rateCheck = await checkRateLimit('REAUTH_FAILED', 'user', user.userId, 15 * 60 * 1000, 5)
  if (!rateCheck.allowed) {
    logRateLimitExceeded(user.userId, '/api/auth/reauth', userAgent)
    setResponseHeader(event, 'Retry-After', rateCheck.retryAfterSeconds!)
    throw createError({ statusCode: 429, statusMessage: 'Too many attempts. Try again later.' })
  }

  const row = await db.selectFrom('users').select('password').where('id', '=', user.userId).executeTakeFirst()
  const ok = row?.password ? await bcrypt.compare(password, row.password) : false
  if (!ok) {
    logEvent({ eventType: 'REAUTH_FAILED', userId: user.userId, userAgent, metadata: { user: user.userId } })
    throw createError({ statusCode: 401, statusMessage: 'Password is incorrect' })
  }

  await markReauthenticated(user.sid)
  logEvent({ eventType: 'REAUTH', tableName: 'sessions', recordId: user.sid, userId: user.userId, userAgent })
  return { success: true }
})
