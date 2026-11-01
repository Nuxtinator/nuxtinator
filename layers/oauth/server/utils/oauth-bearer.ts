import type { H3Event } from 'h3'
import { db } from '#core/server/utils/database'
import { getUserPermissionsForRequest } from '#tenant/server'
import type { Permission } from '#core/app/utils/permissions'
import { isRegisteredPermission } from '#core/server/utils/permissions-registry'
import { sha256Hex } from './oauth-crypto'
import { getOauthConfig, tryGetOauthConfig } from './oauth-config'
import { parseScopeString, OFFLINE_ACCESS_SCOPE } from './oauth-validation'

export interface BearerAuth {
  userId: string
  clientId: string
  scopes: string[]
  tokenId: string
  familyId: string
}

type BearerParse
  = | { kind: 'none' }
    | { kind: 'malformed' }
    | { kind: 'ok', token: string }

function parseBearer(header: string | undefined): BearerParse {
  if (!header) return { kind: 'none' }
  const match = /^\s*([A-Za-z]+)\s+(.*?)\s*$/.exec(header)
  if (!match) return { kind: 'none' }
  const scheme = match[1]
  const payload = match[2]
  if (!scheme || scheme.toLowerCase() !== 'bearer') return { kind: 'none' }
  if (!payload) return { kind: 'malformed' }
  // RFC 6750 §2.1: b64token = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(payload)) return { kind: 'malformed' }
  return { kind: 'ok', token: payload }
}

interface UnauthorizedOpts {
  requiredScope?: string
  error?: 'invalid_token' | 'insufficient_scope'
  status?: number
}

function buildWwwAuthenticate(opts: { error?: string, scope?: string }): string {
  const parts: string[] = ['realm="mcp"']
  if (opts.error) parts.push(`error="${opts.error}"`)
  if (opts.scope) parts.push(`scope="${opts.scope}"`)
  const cfg = tryGetOauthConfig()
  if (cfg) {
    // Per RFC 9728 §3.1 / §5.1, resources with a path component
    // expose their metadata at /.well-known/oauth-protected-resource/<path>.
    // Pointing clients at this path-specific URL (rather than the
    // path-less form) keeps discovery aligned with what MCP 2025-06-18+
    // clients fetch by default.
    let resourceMeta = `${cfg.issuer}/.well-known/oauth-protected-resource`
    try {
      const path = new URL(cfg.mcpResource).pathname.replace(/^\/+|\/+$/g, '')
      if (path) resourceMeta = `${resourceMeta}/${path}`
    }
    catch {
      // Fall back to path-less form on URL parse failure.
    }
    parts.push(`resource_metadata="${resourceMeta}"`)
  }
  return `Bearer ${parts.join(', ')}`
}

function sendAuthError(event: H3Event, status: number, opts: UnauthorizedOpts, errorKey: string): never {
  setResponseHeader(event, 'WWW-Authenticate', buildWwwAuthenticate({
    error: opts.error,
    scope: opts.requiredScope
  }))
  throw createError({
    statusCode: status,
    statusMessage: errorKey
  })
}

// 403 for a valid token that lacks `scope`, with the `insufficient_scope`
// challenge clients use to ask the user for more.
export function rejectInsufficientScope(event: H3Event, scope: string): never {
  sendAuthError(event, 403, { requiredScope: scope, error: 'insufficient_scope' }, 'Forbidden')
}

// Validates token + audience + family + client-enabled. Does NOT enforce a
// specific scope or RBAC permission — callers that need that gate use the
// `requireBearerScope` wrapper below. The MCP transport boundary uses this
// helper directly so each tool can apply its own scope check after dispatch.
export async function requireValidBearer(event: H3Event, requiredScope?: string): Promise<BearerAuth> {
  const parsed = parseBearer(getHeader(event, 'authorization'))

  if (parsed.kind === 'none') {
    // Variant A — no credentials, no error= attribute
    sendAuthError(event, 401, { requiredScope }, 'Unauthorized')
  }
  if (parsed.kind === 'malformed') {
    sendAuthError(event, 401, { requiredScope, error: 'invalid_token' }, 'Unauthorized')
  }

  const hash = sha256Hex(parsed.token)

  const row = await db
    .selectFrom('oauth_access_tokens')
    .selectAll()
    .where('token_hash', '=', hash)
    .executeTakeFirst()

  if (!row || row.revoked || new Date(row.expires) < new Date()) {
    sendAuthError(event, 401, { requiredScope, error: 'invalid_token' }, 'Unauthorized')
  }

  const family = await db
    .selectFrom('oauth_token_families')
    .select(['revoked'])
    .where('family_id', '=', row.family_id)
    .executeTakeFirst()

  if (!family || family.revoked) {
    sendAuthError(event, 401, { requiredScope, error: 'invalid_token' }, 'Unauthorized')
  }

  const cfg = getOauthConfig()
  if (row.resource !== cfg.mcpResource) {
    sendAuthError(event, 401, { requiredScope, error: 'invalid_token' }, 'Unauthorized')
  }

  const client = await db
    .selectFrom('oauth_clients')
    .select(['enabled'])
    .where('client_id', '=', row.client_id)
    .executeTakeFirst()

  if (!client?.enabled) {
    sendAuthError(event, 401, { requiredScope, error: 'invalid_token' }, 'Unauthorized')
  }

  const scopes = parseScopeString(row.scope)

  // Fire-and-forget last_used update
  db.updateTable('oauth_access_tokens')
    .set({ last_used: new Date() })
    .where('token_hash', '=', hash)
    .execute()
    .catch(() => {})

  return {
    userId: row.user_id,
    clientId: row.client_id,
    scopes,
    tokenId: row.id,
    familyId: row.family_id
  }
}

export async function requireBearerScope(event: H3Event, requiredScope: string): Promise<BearerAuth> {
  const auth = await requireValidBearer(event, requiredScope)

  if (!auth.scopes.includes(requiredScope)) {
    rejectInsufficientScope(event, requiredScope)
  }

  // RBAC check: scope alone does not grant — current user permission is source of truth.
  // offline_access is OAuth-protocol, not a permission, so it doesn't need an RBAC check.
  // Runtime registry check (`isRegisteredPermission`), not the host's empty
  // static PERMISSIONS array — layer-contributed scopes must reach the RBAC gate.
  if (requiredScope !== OFFLINE_ACCESS_SCOPE && isRegisteredPermission(requiredScope)) {
    const perms = await getUserPermissionsForRequest(event, auth.userId)
    if (!perms.has(requiredScope as Permission)) {
      sendAuthError(event, 403, { requiredScope, error: 'insufficient_scope' }, 'Forbidden')
    }
  }

  return auth
}
