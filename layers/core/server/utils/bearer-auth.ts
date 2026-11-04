// OAuth bearer tokens on the standard handlers (`#tenant/server` in both
// modes, and the personal-app handlers). The oauth layer registers how a token
// is checked; without it, an OAuth token is not a sign-in.
//
// A request carries an OAuth token when its `Authorization: Bearer` header
// holds something that isn't a session access token (native-app sign-in sends
// those in the same header). The token wins over a session cookie on the same
// request.
//
// On the token path a handler only ever sees what the token was granted: its
// `ctx.perms` is the user's permissions narrowed to the token's scopes, and a
// route that names no permission refuses tokens, since the user had nothing
// to untick for it.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { H3Event } from 'h3'
import type { Permission } from '#core/app/utils/permissions'
import { verifyToken } from './auth'

export interface BearerIdentity {
  userId: string
  // The OAuth client acting for the user.
  clientId: string
  scopes: string[]
}

export interface BearerAuthenticator {
  // Validates the request's token and returns who it acts for. Throws 401 for
  // a token that isn't valid.
  authenticate: (event: H3Event) => Promise<BearerIdentity>
  // Refuses a valid token that lacks `scope` (403).
  rejectScope?: (event: H3Event, scope: string) => never
}

let _authenticator: BearerAuthenticator | null = null

export function registerBearerAuth(authenticator: BearerAuthenticator): void {
  _authenticator = authenticator
}

// The request's bearer header value when it isn't a session access token.
function oauthBearerToken(event: H3Event): string | null {
  const header = getHeader(event, 'authorization') || ''
  if (!header.toLowerCase().startsWith('bearer ')) return null
  const token = header.slice(7).trim()
  if (!token || verifyToken(token)) return null
  return token
}

export function hasOauthBearer(event: H3Event): boolean {
  return oauthBearerToken(event) !== null
}

// The OAuth identity the request signs in with, or null for a session request.
export async function getBearerIdentity(event: H3Event): Promise<BearerIdentity | null> {
  const cached = event.context.bearerIdentity as BearerIdentity | undefined
  if (cached) return cached
  if (!hasOauthBearer(event)) return null
  if (!_authenticator) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  }
  const identity = await _authenticator.authenticate(event)
  event.context.bearerIdentity = identity
  return identity
}

// The gate every token request passes before its handler runs: the route
// must name a permission, and the token must carry it.
export function requireBearerPermission(event: H3Event, identity: BearerIdentity, perm: Permission | undefined): void {
  if (!perm) {
    throw createError({ statusCode: 403, statusMessage: 'This route does not accept OAuth tokens.' })
  }
  if (!identity.scopes.includes(perm)) {
    if (_authenticator?.rejectScope) _authenticator.rejectScope(event, perm)
    throw createError({ statusCode: 403, statusMessage: `Permission required: ${perm}` })
  }
}

export function narrowToScopes(perms: Set<Permission>, scopes: string[]): Set<Permission> {
  const granted = new Set(scopes)
  return new Set([...perms].filter(p => granted.has(p)))
}

// The OAuth client a request's work runs on behalf of, so the activity log can
// record it without each handler passing it along.
const clientContext = new AsyncLocalStorage<string>()

export function runAsOauthClient<T>(clientId: string | null, fn: () => Promise<T>): Promise<T> {
  return clientId ? clientContext.run(clientId, fn) : fn()
}

export function currentOauthClientId(): string | null {
  return clientContext.getStore() ?? null
}
