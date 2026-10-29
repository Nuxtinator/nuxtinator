import { createHash, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { H3Event } from 'h3'
import { db } from './database'
import { getClientIp } from './client-ip'
import { logEvent } from './activity-logger'
import { requireAuth, type SessionTokenPayload } from './auth'
import { cookieName } from './cookie-names'
import type { SessionClient } from '#core/server/database/schema'

// Sessions: a short-lived access JWT plus a rotating refresh token, one
// `sessions` row per signed-in device. Browsers get both as httpOnly cookies
// and are refreshed transparently by the session-refresh plugin; native apps
// (requests sent with `X-Auth-Client: native`) get them in the response body,
// send the access token as `Authorization: Bearer`, and call
// `/api/auth/refresh` themselves.

export const ACCESS_COOKIE = 'auth-token'
export const REFRESH_COOKIE = 'auth-refresh'

export const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_MS = 120 * 24 * 60 * 60 * 1000
// A refresh token that was just rotated stays usable this long, so parallel
// requests that raced the same rotation don't sign the device out.
const ROTATION_GRACE_MS = 60 * 1000
// How recently the user must have proven who they are for sensitive actions.
export const REAUTH_WINDOW_MS = 5 * 60 * 1000

export interface SessionUser {
  id: string
  email: string | null
  display_name: string
}

export interface IssuedTokens {
  accessToken: string
  // Null when a refresh fell inside the rotation grace window: the caller keeps
  // the refresh token it already holds (or received from the winning request).
  refreshToken: string | null
  expiresIn: number
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomBytes(32).toString('base64url')}`
}

function sessionIdFromRefreshToken(token: string): string | null {
  const id = token.split('.')[0] ?? ''
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null
}

function signAccessToken(user: SessionUser, sessionId: string): string {
  return jwt.sign(
    { userId: user.id, email: user.email, display_name: user.display_name, sid: sessionId },
    useRuntimeConfig().jwtSecret,
    { expiresIn: ACCESS_TTL_SECONDS }
  )
}

export function isNativeClient(event: H3Event): boolean {
  return (getHeader(event, 'x-auth-client') || '').toLowerCase() === 'native'
}

const cookieBase = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/'
})

export function setSessionCookies(event: H3Event, tokens: IssuedTokens): void {
  setCookie(event, cookieName(ACCESS_COOKIE), tokens.accessToken, { ...cookieBase(), maxAge: ACCESS_TTL_SECONDS })
  if (tokens.refreshToken) {
    setCookie(event, cookieName(REFRESH_COOKIE), tokens.refreshToken, { ...cookieBase(), maxAge: REFRESH_TTL_MS / 1000 })
  }
}

export function clearSessionCookies(event: H3Event): void {
  setCookie(event, cookieName(ACCESS_COOKIE), '', { ...cookieBase(), maxAge: 0 })
  setCookie(event, cookieName(REFRESH_COOKIE), '', { ...cookieBase(), maxAge: 0 })
}

// Creates a session for a user who just proved who they are. Browsers get the
// tokens as cookies; the return value is what a native client receives.
// `authenticatedAt` is when they proved it, for a sign-in handed over from
// elsewhere; it decides whether the session counts as recently authenticated.
export async function startSession(event: H3Event, user: SessionUser, opts: { authenticatedAt?: Date } = {}): Promise<IssuedTokens> {
  const client: SessionClient = isNativeClient(event) ? 'native' : 'web'
  const sessionId = randomUUID()
  const refreshToken = newRefreshToken(sessionId)
  const now = new Date()
  const ip = getClientIp(event)

  await db
    .insertInto('sessions')
    .values({
      id: sessionId,
      user_id: user.id,
      client,
      refresh_token_hash: hashToken(refreshToken),
      created_at: now,
      last_used_at: now,
      authenticated_at: opts.authenticatedAt ?? now,
      expires_at: new Date(now.getTime() + REFRESH_TTL_MS),
      user_agent: getHeader(event, 'user-agent') || null,
      ip: ip && ip !== 'unknown' ? ip : null
    })
    .execute()

  // Expired rows for this user are dead weight; sweep them as new ones appear.
  await db.deleteFrom('sessions').where('user_id', '=', user.id).where('expires_at', '<=', now).execute()

  const tokens: IssuedTokens = {
    accessToken: signAccessToken(user, sessionId),
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS
  }
  if (client === 'web') setSessionCookies(event, tokens)
  return tokens
}

// The token fields a native client receives in a sign-in response body.
export function nativeTokenFields(event: H3Event, tokens: IssuedTokens) {
  if (!isNativeClient(event)) return {}
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn }
}

// Exchanges a refresh token for a new access token, rotating the refresh
// token. Returns null when the token is unknown, expired or revoked. Presenting
// a rotated-out token after the grace window is treated as theft: the whole
// session is revoked.
export async function refreshSession(event: H3Event, refreshToken: string): Promise<IssuedTokens | null> {
  const sessionId = sessionIdFromRefreshToken(refreshToken)
  if (!sessionId) return null
  const hash = hashToken(refreshToken)
  const now = new Date()

  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id as id',
      'sessions.refresh_token_hash as refresh_token_hash',
      'sessions.previous_refresh_token_hash as previous_refresh_token_hash',
      'sessions.rotated_at as rotated_at',
      'sessions.expires_at as expires_at',
      'users.id as user_id',
      'users.email as email',
      'users.display_name as display_name'
    ])
    .where('sessions.id', '=', sessionId)
    .executeTakeFirst()

  if (!row || new Date(row.expires_at).getTime() <= now.getTime()) return null
  const user: SessionUser = { id: row.user_id, email: row.email, display_name: row.display_name }

  if (row.refresh_token_hash === hash) {
    const next = newRefreshToken(sessionId)
    const rotated = await db
      .updateTable('sessions')
      .set({
        refresh_token_hash: hashToken(next),
        previous_refresh_token_hash: hash,
        rotated_at: now,
        last_used_at: now,
        expires_at: new Date(now.getTime() + REFRESH_TTL_MS)
      })
      .where('id', '=', sessionId)
      .where('refresh_token_hash', '=', hash)
      .executeTakeFirst()

    // Lost a race with a concurrent rotation of the same token: that request
    // set the new refresh token, so this one only needs an access token.
    if (Number(rotated.numUpdatedRows) === 0) {
      return { accessToken: signAccessToken(user, sessionId), refreshToken: null, expiresIn: ACCESS_TTL_SECONDS }
    }
    return { accessToken: signAccessToken(user, sessionId), refreshToken: next, expiresIn: ACCESS_TTL_SECONDS }
  }

  if (row.previous_refresh_token_hash === hash) {
    const rotatedAt = row.rotated_at ? new Date(row.rotated_at).getTime() : 0
    if (now.getTime() - rotatedAt <= ROTATION_GRACE_MS) {
      return { accessToken: signAccessToken(user, sessionId), refreshToken: null, expiresIn: ACCESS_TTL_SECONDS }
    }
    await db.deleteFrom('sessions').where('id', '=', sessionId).execute()
    logEvent({
      eventType: 'SESSION_REFRESH_REUSE',
      tableName: 'sessions',
      recordId: sessionId,
      userId: user.id,
      userAgent: getHeader(event, 'user-agent') || undefined
    })
  }

  return null
}

// The session a refresh token belongs to; logout uses it when the access
// token has already expired.
export function sessionIdOf(refreshToken: string): string | null {
  return sessionIdFromRefreshToken(refreshToken)
}

export async function revokeSession(sessionId: string, userId?: string): Promise<boolean> {
  const res = await db
    .deleteFrom('sessions')
    .where('id', '=', sessionId)
    .$if(!!userId, qb => qb.where('user_id', '=', userId!))
    .executeTakeFirst()
  return Number(res.numDeletedRows) > 0
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await db
    .deleteFrom('sessions')
    .where('user_id', '=', userId)
    .$if(!!exceptSessionId, qb => qb.where('id', '!=', exceptSessionId!))
    .execute()
}

export async function listUserSessions(userId: string) {
  return await db
    .selectFrom('sessions')
    .select(['id', 'client', 'created_at', 'last_used_at', 'authenticated_at', 'user_agent', 'ip'])
    .where('user_id', '=', userId)
    .where('expires_at', '>', new Date())
    .orderBy('last_used_at', 'desc')
    .execute()
}

export async function markReauthenticated(sessionId: string): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ authenticated_at: new Date() })
    .where('id', '=', sessionId)
    .execute()
}

export async function hasRecentAuth(sessionId: string): Promise<boolean> {
  const row = await db
    .selectFrom('sessions')
    .select('authenticated_at')
    .where('id', '=', sessionId)
    .executeTakeFirst()
  if (!row) return false
  return Date.now() - new Date(row.authenticated_at).getTime() <= REAUTH_WINDOW_MS
}

// Gate for sensitive actions. Throws 403 with `data.reauth = true`, which the
// client's `useReauth()` turns into a re-authentication prompt.
export async function requireRecentAuth(event: H3Event): Promise<SessionTokenPayload> {
  const user = requireAuth(event)
  if (!(await hasRecentAuth(user.sid))) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Please confirm it\'s you to continue',
      data: { reauth: true }
    })
  }
  return user
}
