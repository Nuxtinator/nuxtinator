import jwt from 'jsonwebtoken'
import type { H3Event } from 'h3'
import type { SocialProviderId, SocialProfile } from './social-providers'

// Short-lived signed cookies that carry state across the provider redirect
// and across the "what should we call you?" step. Both are JWTs signed with
// the app's jwtSecret and tagged with a `scope`, so core's session check
// (which rejects scoped tokens) can never mistake one for a session.

export type SocialIntent = 'login' | 'link' | 'reauth'

export interface SocialFlow {
  provider: SocialProviderId
  state: string
  nonce: string
  codeVerifier: string
  intent: SocialIntent
  invite: string | null
  redirect: string | null
  // For link / reauth: the signed-in user and session that started the flow.
  userId: string | null
  sessionId: string | null
}

export interface PendingSignup {
  provider: SocialProviderId
  profile: SocialProfile
  invite: string | null
  redirect: string | null
  clientId: string | null
  // Apple refresh token, already encrypted with core's secret-crypto.
  refreshTokenEnc: string | null
}

const FLOW_COOKIE = 'social_auth_flow'
const PENDING_COOKIE = 'social_auth_pending'
const FLOW_SCOPE = 'social-auth-flow'
const PENDING_SCOPE = 'social-auth-pending'
const TTL_SECONDS = 10 * 60

function cookieOpts(path: string) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path,
    maxAge: TTL_SECONDS
  }
}

function sign(payload: object, scope: string): string {
  return jwt.sign({ data: payload, scope }, useRuntimeConfig().jwtSecret, { expiresIn: TTL_SECONDS })
}

function verify<T>(token: string | undefined, scope: string): T | null {
  if (!token) return null
  try {
    const decoded = jwt.verify(token, useRuntimeConfig().jwtSecret) as { data?: T, scope?: string }
    return decoded.scope === scope && decoded.data ? decoded.data : null
  } catch {
    return null
  }
}

export function setFlowCookie(event: H3Event, flow: SocialFlow): void {
  setCookie(event, FLOW_COOKIE, sign(flow, FLOW_SCOPE), cookieOpts('/api/social-auth'))
}

// Reads and clears the flow cookie: each flow can complete once.
export function takeFlowCookie(event: H3Event): SocialFlow | null {
  const flow = verify<SocialFlow>(getCookie(event, FLOW_COOKIE), FLOW_SCOPE)
  deleteCookie(event, FLOW_COOKIE, { path: '/api/social-auth' })
  return flow
}

export function setPendingSignup(event: H3Event, pending: PendingSignup): void {
  setCookie(event, PENDING_COOKIE, sign(pending, PENDING_SCOPE), cookieOpts('/'))
}

export function readPendingSignup(event: H3Event): PendingSignup | null {
  return verify<PendingSignup>(getCookie(event, PENDING_COOKIE), PENDING_SCOPE)
}

export function clearPendingSignup(event: H3Event): void {
  deleteCookie(event, PENDING_COOKIE, { path: '/' })
}

// Only same-site paths are accepted as post-sign-in destinations, checked in
// normalised form so dot segments can't turn one into `//other.host`.
export function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(value, 'http://local')
  } catch {
    return null
  }
  const path = `${url.pathname}${url.search}${url.hash}`
  if (url.origin !== 'http://local' || path.startsWith('//')) return null
  return path.slice(0, 1000)
}
