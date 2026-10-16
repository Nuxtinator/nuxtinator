import bcrypt from 'bcrypt'
import type { H3Event } from 'h3'
import { db } from './database'
import { logLoginFailed } from './activity-logger'
import { checkRateLimit, consumeRateLimit, logRateLimitExceeded } from './rate-limit'

// Anything that accepts an account's password for an email (password login,
// linking a sign-in provider to a password account) shares one set of limits
// and one failure log, so a second entry point can't add guesses.

const WINDOW_MS = 15 * 60 * 1000

// Two limits per email: 5 failures, and 10 attempts of any outcome. The
// attempt count is reserved atomically, so a burst of concurrent requests
// can't all pass before their failures are logged. Throws 429 when exceeded.
export async function enforceLoginRateLimit(event: H3Event, email: string, endpoint: string): Promise<void> {
  const attempts = await consumeRateLimit('LOGIN_ATTEMPT', 'email', email, WINDOW_MS, 10)
  const rateCheck = attempts.allowed ? await checkRateLimit('LOGIN_FAILED', 'email', email, WINDOW_MS, 5) : attempts
  if (rateCheck.allowed) return

  logRateLimitExceeded(email, endpoint, getHeader(event, 'user-agent') || undefined)
  setResponseHeader(event, 'Retry-After', rateCheck.retryAfterSeconds!)
  throw createError({
    statusCode: 429,
    statusMessage: `Too many login attempts. Try again in ${Math.ceil(rateCheck.retryAfterSeconds! / 60)} minutes.`
  })
}

// True when `password` is the account's password. A wrong one is logged as a
// login failure against the account's email, counting toward the limit above.
export async function checkAccountPassword(
  account: { id: string, email: string },
  password: string,
  userAgent?: string
): Promise<boolean> {
  const row = await db.selectFrom('users').select('password').where('id', '=', account.id).executeTakeFirst()
  const ok = row?.password ? await bcrypt.compare(password, row.password) : false
  if (!ok) logLoginFailed(account.email, userAgent, { reason: 'invalid_password' })
  return ok
}
