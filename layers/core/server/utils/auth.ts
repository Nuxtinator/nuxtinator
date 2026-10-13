import jwt from 'jsonwebtoken'
import type { SignOptions } from 'jsonwebtoken'
import type { H3Event } from 'h3'

export interface AuthTokenPayload {
  userId: string
  email: string
  display_name: string
}

// A session access token also carries the id of its `sessions` row, which is
// what refresh, logout and step-up re-authentication act on.
export interface SessionTokenPayload extends AuthTokenPayload {
  sid: string
}

// A scoped token is a narrow, stateless credential a layer hands to a
// less-trusted holder (e.g. an embeddable widget on a third-party origin). It
// carries a `scope` claim and is NOT interchangeable with a full session:
// `verifyToken` (the session path) rejects any token that has a scope, and
// `verifyScopedToken` accepts only an exact scope match. Both are signed with
// the same `jwtSecret`, so the scope claim — not the key — is the boundary.
export function signScopedToken(payload: AuthTokenPayload, scope: string, expiresIn: string): string {
  return jwt.sign({ ...payload, scope }, useRuntimeConfig().jwtSecret, {
    expiresIn: expiresIn as SignOptions['expiresIn']
  })
}

export function verifyScopedToken(token: string, scope: string) {
  try {
    const decoded = jwt.verify(token, useRuntimeConfig().jwtSecret) as AuthTokenPayload & { scope?: string }
    return decoded.scope === scope ? decoded : null
  } catch {
    return null
  }
}

// Verifies a session access token. A token carrying a scope is a narrow
// credential, and one without a session id was not issued by `sessions.ts`;
// neither is a session.
export function verifyToken(token: string): SessionTokenPayload | null {
  try {
    const decoded = jwt.verify(token, useRuntimeConfig().jwtSecret) as SessionTokenPayload & { scope?: string }
    if (decoded.scope) return null
    if (typeof decoded.sid !== 'string' || !decoded.sid) return null
    return decoded
  } catch {
    return null
  }
}

// The access token for this request: one minted earlier in the request by the
// session-refresh plugin, else the `auth-token` cookie (browser), else an
// `Authorization: Bearer` header (native apps).
export function getAccessToken(event: H3Event): string | null {
  const refreshed = event.context.refreshedAccessToken
  if (typeof refreshed === 'string' && refreshed) return refreshed

  const cookie = getCookie(event, 'auth-token')
  if (cookie) return cookie

  const header = getHeader(event, 'authorization') || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim()
    if (token) return token
  }
  return null
}

export function requireAuth(event: H3Event) {
  const user = getAuthUser(event)

  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  }

  return user
}

export function getAuthUser(event: H3Event) {
  const token = getAccessToken(event)
  return token ? verifyToken(token) : null
}
