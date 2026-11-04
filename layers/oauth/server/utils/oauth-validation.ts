import { PERMISSIONS } from '#core/app/utils/permissions'
import type { Permission } from '#core/app/utils/permissions'
import { isRegisteredPermission } from '#core/server/utils/permissions-registry'
import { getRegisteredScopes } from './scopes-registry'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// Schemes a browser executes rather than hands to an application. The
// authorize endpoint answers with a 302 to the redirect URI carrying the
// code, so none of these can ever be a redirect target.
const EXECUTABLE_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:'])

export interface ParsedRedirectUri {
  valid: boolean
  serialized?: string
  error?: string
}

// Parses a redirect URI and enforces registration-time rules: absolute URL,
// no fragment, no userinfo, no wildcards. Three scheme classes are accepted,
// following RFC 8252 for native apps:
//   - `https` to any host.
//   - `http` only to a loopback host (§7.3) — a native app listening on an
//     ephemeral local port; the port may differ per session, see
//     matchesRegisteredRedirect.
//   - any other scheme as a private-use scheme (§7.1) that the OS routes to
//     the app that registered it — `cursor://anysphere.cursor-mcp/oauth/callback`,
//     `com.example.app:/oauth2redirect`. Such a scheme is not globally
//     unique, so a squatting app could receive the callback; the mandatory
//     S256 PKCE on the token exchange makes the intercepted code useless.
// Browser-executable schemes are refused outright. Returns the serialized
// form (new URL(input).toString()) for exact-string match.
export function parseRedirectUri(input: string): ParsedRedirectUri {
  if (typeof input !== 'string' || input.length === 0) {
    return { valid: false, error: 'redirect_uri is required' }
  }
  if (input.length > 512) {
    return { valid: false, error: 'redirect_uri exceeds 512 characters' }
  }
  if (input.includes('*')) {
    return { valid: false, error: 'redirect_uri must not contain wildcards' }
  }
  if (input.includes('#')) {
    return { valid: false, error: 'redirect_uri must not contain a fragment' }
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { valid: false, error: 'redirect_uri must be an absolute URL' }
  }
  if (!url.protocol) {
    return { valid: false, error: 'redirect_uri must include a scheme' }
  }
  if (url.hash) {
    return { valid: false, error: 'redirect_uri must not contain a fragment' }
  }
  if (url.username || url.password) {
    return { valid: false, error: 'redirect_uri must not contain userinfo' }
  }
  if (EXECUTABLE_SCHEMES.has(url.protocol)) {
    return { valid: false, error: `redirect_uri must not use the ${url.protocol} scheme` }
  }
  const isHttp = url.protocol === 'http:'
  const isHttps = url.protocol === 'https:'
  if (isHttp || isHttps) {
    if (!url.host) {
      return { valid: false, error: 'redirect_uri must include a host' }
    }
    if (isHttp && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      return { valid: false, error: 'redirect_uri must use https (http allowed only for loopback)' }
    }
  } else if (!url.host && !url.pathname) {
    return { valid: false, error: 'redirect_uri must include a host or path after the scheme' }
  }
  return { valid: true, serialized: url.toString() }
}

// RFC 8252 §7.3 — for loopback redirect URIs the port is allowed to
// vary between registration and the authorize request, since native
// apps may pick an ephemeral port per session. Exact-string match is
// the fast path (the typical case where a client pins a port at DCR
// time and reuses it); we only fall back to port-fuzzy matching when
// both the supplied URI and at least one registered URI are loopback.
//
// Hostname is required to match (we don't cross-match `localhost`
// with `127.0.0.1` — clients that want both should register both).
// Path and query are required to match.
export function matchesRegisteredRedirect(supplied: string, registered: readonly string[]): boolean {
  if (registered.includes(supplied)) return true

  let suppliedUrl: URL
  try {
    suppliedUrl = new URL(supplied)
  }
  catch {
    return false
  }

  const isSuppliedLoopback
    = suppliedUrl.protocol === 'http:'
      && LOOPBACK_HOSTS.has(suppliedUrl.hostname.toLowerCase())
  if (!isSuppliedLoopback) return false

  return registered.some((r) => {
    let u: URL
    try {
      u = new URL(r)
    }
    catch {
      return false
    }
    return u.protocol === 'http:'
      && LOOPBACK_HOSTS.has(u.hostname.toLowerCase())
      && u.hostname.toLowerCase() === suppliedUrl.hostname.toLowerCase()
      && u.pathname === suppliedUrl.pathname
      && u.search === suppliedUrl.search
  })
}

export function buildRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.append(k, v)
  }
  return url.toString()
}

// Scope helpers — scopes in this layer are either permission strings from the
// consumer's PERMISSIONS list, or the literal `offline_access` (OAuth-protocol
// concept meaning "issue a refresh token"; not a permission).

export const OFFLINE_ACCESS_SCOPE = 'offline_access'

// The set of scopes the server advertises in /.well-known/* discovery and
// accepts at DCR time. Three sources contribute, in priority order:
//
//   1. The dynamic registry (`scopes-registry.ts`). Layers self-register
//      scopes their surface needs — e.g. the MCP layer's tool registry
//      calls `registerScope(tool.scope)` when each tool registers, so
//      a fresh deployment doesn't need to enumerate them in nuxt.config.
//   2. The consumer's `runtimeConfig.oauthAdvertisedScopes` runtime config.
//      Additive — for scopes outside any layer's auto-registered surface
//      (e.g. an admin REST surface using `admin.access` directly).
//   3. `offline_access` is always advertised when the dynamic-registry
//      path is active, since refresh-token semantics belong to OAuth itself
//      rather than any feature layer.
//
// Legacy fallback: if BOTH the registry and the consumer config are empty
// (an OAuth-only deployment with no MCP tools and no manual override),
// advertise the full PERMISSIONS catalog plus offline_access — the
// pre-registry default. Once any contribution arrives, the legacy path
// is replaced by the union above.
export function getAdvertisedScopes(): string[] {
  const dynamic = getRegisteredScopes()
  const fromConfig = (useRuntimeConfig().oauthAdvertisedScopes as string[] | undefined) ?? []

  if (dynamic.length === 0 && fromConfig.length === 0) {
    return [...PERMISSIONS, OFFLINE_ACCESS_SCOPE]
  }

  return Array.from(new Set([...dynamic, ...fromConfig, OFFLINE_ACCESS_SCOPE]))
}

export function parseScopeString(raw: string | undefined | null): string[] {
  if (!raw) return []
  return raw.split(/\s+/).filter(Boolean)
}

// True if the scope is a known permission OR the offline_access protocol scope.
// Checks the runtime permission registry (fed by each layer's Nitro plugin),
// not the host's static PERMISSIONS array — the host owns no permissions of
// its own, so the compile-time `isPermission()` would reject every
// layer-contributed scope.
export function isValidScope(scope: string): boolean {
  if (scope === OFFLINE_ACCESS_SCOPE) return true
  return isRegisteredPermission(scope)
}

// Returns only scopes the user currently has the RBAC permission for.
// offline_access passes through unconditionally (it's not a permission).
// Membership is checked against the runtime permission registry (see
// isValidScope above) — the static-array check would drop every
// layer-contributed scope here, granting consent tokens with no usable scope.
export function filterScopesByPermissions(scopes: string[], userPermissions: Set<Permission>): string[] {
  const surviving: string[] = []
  for (const scope of scopes) {
    if (scope === OFFLINE_ACCESS_SCOPE) {
      surviving.push(scope)
      continue
    }
    if (isRegisteredPermission(scope) && userPermissions.has(scope as Permission)) {
      surviving.push(scope)
    }
  }
  return surviving
}

// True if `subset` is fully covered by `superset`.
export function isScopeSubset(subset: string[], superset: string[]): boolean {
  const set = new Set(superset)
  return subset.every(s => set.has(s))
}

// True if at least one scope grants real access (i.e. there's a permission scope present,
// not just offline_access).
export function hasAnyPermissionScope(scopes: string[]): boolean {
  return scopes.some(s => s !== OFFLINE_ACCESS_SCOPE)
}
