import type { H3Event } from 'h3'
import { db } from '#core/server/utils/database'
import { PERMISSIONS } from '#core/app/utils/permissions'
import { checkRateLimit, logRateLimitExceeded } from '#core/server/utils/rate-limit'
import { getOauthConfig } from '../../utils/oauth-config'
import { randomClientId } from '../../utils/oauth-crypto'
import {
  parseRedirectUri,
  parseScopeString,
  isValidScope,
  getAdvertisedScopes,
  OFFLINE_ACCESS_SCOPE
} from '../../utils/oauth-validation'
import { logOauthEvent, OAUTH_EVENTS } from '../../utils/oauth-audit'
import { getClientIp } from '#core/server/utils/client-ip'

const MAX_BODY_SIZE = 4 * 1024
const MAX_CLIENT_NAME = 256
const MAX_REDIRECT_URIS = 10
const MAX_SCOPE_LEN = 1024

interface OauthErrorBody {
  error: string
  error_description: string
}

function oauthError(event: H3Event, status: number, error: string, description: string): OauthErrorBody {
  setResponseStatus(event, status)
  return { error, error_description: description }
}

interface RegistrationBody {
  client_name?: unknown
  redirect_uris?: unknown
  token_endpoint_auth_method?: unknown
  grant_types?: unknown
  scope?: unknown
}

function normalizeClientName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed) return null
  if (trimmed.length > MAX_CLIENT_NAME) return null
  // Reject control characters (0x00–0x1F and 0x7F)
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return null
  }
  return trimmed
}

// Default scope cap for dynamically registered clients.
//
// When the consumer sets `runtimeConfig.oauthDcrDefaultScopes`, that
// curated list is used verbatim — any DCR registration omitting `scope`
// is registered against exactly those scopes. This keeps consent
// surfaces narrow and prevents new permissions from silently expanding
// the default catalog.
//
// When unset, the legacy fallback applies: every project permission
// plus offline_access. Token issuance still intersects with the user's
// actual RBAC at consent time, so the cap of "all permissions" is safe
// in single-purpose deployments — it just means the client isn't
// pre-restricted at registration.
function defaultDcrScopes(): string[] {
  const cfg = useRuntimeConfig()
  const override = cfg.oauthDcrDefaultScopes as unknown
  if (Array.isArray(override)) {
    const advertised = new Set(getAdvertisedScopes())
    // Reject offline_access from the array — clients must request
    // refresh tokens explicitly via the registration scope param.
    for (const s of override) {
      if (typeof s !== 'string') {
        throw new Error(`[oauth] runtimeConfig.oauthDcrDefaultScopes contains a non-string entry: ${JSON.stringify(s)}`)
      }
      if (s === OFFLINE_ACCESS_SCOPE) {
        throw new Error('[oauth] runtimeConfig.oauthDcrDefaultScopes must not include offline_access')
      }
      if (!isValidScope(s)) {
        throw new Error(`[oauth] runtimeConfig.oauthDcrDefaultScopes contains an unknown scope: ${s}`)
      }
      if (!advertised.has(s)) {
        throw new Error(`[oauth] runtimeConfig.oauthDcrDefaultScopes contains scope "${s}" which is not in oauthAdvertisedScopes`)
      }
    }
    return [...override as string[]]
  }
  return [...PERMISSIONS, OFFLINE_ACCESS_SCOPE]
}

export default defineEventHandler(async (event) => {
  const cfg = getOauthConfig()

  if (!cfg.allowDcr) {
    setResponseStatus(event, 403)
    return {
      error: 'registration_disabled',
      error_description: 'Dynamic client registration is not enabled on this server. Contact an administrator.'
    }
  }

  const ip = getClientIp(event)
  const userAgent = getHeader(event, 'user-agent') || undefined

  const rate = await checkRateLimit(OAUTH_EVENTS.CLIENT_REGISTERED, 'ip', ip, 60 * 60 * 1000, 20)
  if (!rate.allowed) {
    logRateLimitExceeded(ip, '/oauth/register', userAgent)
    setResponseStatus(event, 429)
    if (rate.retryAfterSeconds) setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    return { error: 'too_many_requests', error_description: 'Rate limit exceeded' }
  }

  const contentLength = Number(getHeader(event, 'content-length') ?? 0)
  if (contentLength > MAX_BODY_SIZE) {
    return oauthError(event, 400, 'invalid_request', `Request body exceeds ${MAX_BODY_SIZE} bytes`)
  }

  const body = await readBody<RegistrationBody>(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    return oauthError(event, 400, 'invalid_request', 'Request body must be a JSON object')
  }

  const clientName = normalizeClientName(body.client_name)
  if (!clientName) {
    return oauthError(event, 400, 'invalid_client_metadata', 'client_name is required (1-256 chars, no control characters)')
  }

  const redirectUrisIn = body.redirect_uris
  if (!Array.isArray(redirectUrisIn) || redirectUrisIn.length === 0) {
    return oauthError(event, 400, 'invalid_redirect_uri', 'redirect_uris is required and must be a non-empty array')
  }
  if (redirectUrisIn.length > MAX_REDIRECT_URIS) {
    return oauthError(event, 400, 'invalid_redirect_uri', `redirect_uris must contain at most ${MAX_REDIRECT_URIS} entries`)
  }
  const redirectUris: string[] = []
  for (const raw of redirectUrisIn) {
    const parsed = parseRedirectUri(String(raw))
    if (!parsed.valid || !parsed.serialized) {
      return oauthError(event, 400, 'invalid_redirect_uri', parsed.error || 'invalid redirect_uri')
    }
    redirectUris.push(parsed.serialized)
  }

  const authMethod = body.token_endpoint_auth_method ?? 'none'
  if (authMethod !== 'none') {
    return oauthError(event, 400, 'invalid_client_metadata', 'Only token_endpoint_auth_method=none is supported')
  }

  const grantTypes: string[] = Array.isArray(body.grant_types) && body.grant_types.length > 0
    ? (body.grant_types as unknown[]).map(g => String(g))
    : ['authorization_code', 'refresh_token']
  const allowedGrants = new Set(['authorization_code', 'refresh_token'])
  for (const g of grantTypes) {
    if (!allowedGrants.has(g)) {
      return oauthError(event, 400, 'invalid_client_metadata', `Unsupported grant_type: ${g}`)
    }
  }

  // Scope defaulting + validation. Explicit scopes are clipped to the
  // advertised set so a client that ignores discovery and asks for, say,
  // `users.manage` directly is rejected — the consent screen would
  // otherwise show permissions this server has no MCP-tool use for.
  const advertised = new Set(getAdvertisedScopes())
  let scopeList: string[]
  if (typeof body.scope === 'string') {
    if (body.scope.length > MAX_SCOPE_LEN) {
      return oauthError(event, 400, 'invalid_client_metadata', 'scope too long')
    }
    const requested = parseScopeString(body.scope)
    for (const s of requested) {
      if (!isValidScope(s)) {
        return oauthError(event, 400, 'invalid_client_metadata', `Unknown scope: ${s}`)
      }
      if (!advertised.has(s)) {
        return oauthError(event, 400, 'invalid_client_metadata', `Scope "${s}" is not advertised by this server`)
      }
    }
    scopeList = requested
  } else if (body.scope === undefined || body.scope === null) {
    scopeList = defaultDcrScopes()
  } else {
    return oauthError(event, 400, 'invalid_client_metadata', 'scope must be a space-separated string')
  }

  const clientId = randomClientId()
  const issuedAt = Math.floor(Date.now() / 1000)

  await db.insertInto('oauth_clients').values({
    client_id: clientId,
    client_name: clientName as string,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: 'none',
    scope: scopeList.join(' '),
    dynamic: true,
    enabled: true,
    created_by: null
  }).execute()

  logOauthEvent({
    event: OAUTH_EVENTS.CLIENT_REGISTERED,
    event3: event,
    metadata: {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      scope: scopeList.join(' '),
      dynamic: true,
      ip
    }
  })

  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: 'none',
    scope: scopeList.join(' ')
  }
})
