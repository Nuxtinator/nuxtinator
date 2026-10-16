import type { H3Event } from 'h3'
import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { getUserPermissionsAcrossOrgs } from '#tenant/server'
import { consumeRateLimit, logRateLimitExceeded } from '#core/server/utils/rate-limit'
import { getOauthConfig } from '../../utils/oauth-config'
import {
  sha256Hex,
  newAccessToken,
  newRefreshToken,
  s256Challenge,
  isValidPkceVerifier,
  constantTimeEqual
} from '../../utils/oauth-crypto'
import {
  filterScopesByPermissions,
  hasAnyPermissionScope,
  parseScopeString,
  OFFLINE_ACCESS_SCOPE
} from '../../utils/oauth-validation'
import { logOauthEvent, OAUTH_EVENTS } from '../../utils/oauth-audit'
import { revokeFamily } from '../../utils/oauth-revoke'
import { getClientIp } from '#core/server/utils/client-ip'

type TokenErrorCode
  = | 'invalid_request'
    | 'invalid_grant'
    | 'invalid_target'
    | 'invalid_scope'
    | 'unsupported_grant_type'

function setNoCache(event: H3Event) {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Pragma', 'no-cache')
}

function tokenError(event: H3Event, status: number, code: TokenErrorCode, desc: string) {
  setResponseStatus(event, status)
  setNoCache(event)
  return { error: code, error_description: desc }
}

function parseUrlEncoded(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const params = new URLSearchParams(raw)
  for (const [k, v] of params.entries()) {
    out[k] = v
  }
  return out
}

export default defineEventHandler(async (event) => {
  const cfg = getOauthConfig()

  // Rate limit
  const ip = getClientIp(event)
  const userAgent = getHeader(event, 'user-agent') || undefined
  // Counts and records in one locked step, so parallel requests can't all pass.
  // Kept under the `ratelimit.*` namespace (not `oauth.*`) so it's prunable
  // bookkeeping, not an audit event in the events view.
  const rate = await consumeRateLimit('ratelimit.oauth.token', 'ip', ip, 60 * 1000, 60)
  if (!rate.allowed) {
    logRateLimitExceeded(ip, '/oauth/token', userAgent)
    setResponseStatus(event, 429)
    if (rate.retryAfterSeconds) setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    setNoCache(event)
    return { error: 'too_many_requests' }
  }

  // Content-Type check (accept application/x-www-form-urlencoded[; charset=...])
  const contentType = getHeader(event, 'content-type') || ''
  const media = (contentType.split(';')[0] || '').trim().toLowerCase()
  if (media !== 'application/x-www-form-urlencoded') {
    return tokenError(event, 400, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded')
  }

  const rawBody = await readRawBody(event, 'utf8')
  if (!rawBody) {
    return tokenError(event, 400, 'invalid_request', 'Empty body')
  }
  const params = parseUrlEncoded(String(rawBody))

  const grantType = params.grant_type
  const clientId = params.client_id
  const resource = params.resource

  if (!grantType) return tokenError(event, 400, 'invalid_request', 'grant_type is required')
  if (!clientId) return tokenError(event, 400, 'invalid_request', 'client_id is required')
  if (!resource) return tokenError(event, 400, 'invalid_target', 'resource parameter is required')

  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return tokenError(event, 400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`)
  }

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(event, cfg, params)
  }
  return handleRefreshTokenGrant(event, cfg, params)
})

// ──────────────────────────────────────────────────────────
// authorization_code grant
// ──────────────────────────────────────────────────────────

async function handleAuthorizationCodeGrant(event: H3Event, cfg: ReturnType<typeof getOauthConfig>, params: Record<string, string>) {
  const code = params.code
  const redirectUri = params.redirect_uri
  const codeVerifier = params.code_verifier
  const clientId = params.client_id!
  const resource = params.resource!

  if (!code) return tokenError(event, 400, 'invalid_request', 'code is required')
  if (!redirectUri) return tokenError(event, 400, 'invalid_request', 'redirect_uri is required')
  if (!codeVerifier) return tokenError(event, 400, 'invalid_request', 'code_verifier is required')

  const codeHash = sha256Hex(code)

  // Phase 1 — atomic claim
  const claimed = await db
    .updateTable('oauth_authorization_codes')
    .set({ used: true })
    .where('code_hash', '=', codeHash)
    .where('used', '=', false)
    .where('expires', '>', sql<Date>`now()`)
    .returningAll()
    .executeTakeFirst()

  if (!claimed) {
    // Look up separately to diagnose
    const existing = await db
      .selectFrom('oauth_authorization_codes')
      .selectAll()
      .where('code_hash', '=', codeHash)
      .executeTakeFirst()

    if (!existing) {
      return tokenError(event, 400, 'invalid_grant', 'Code not found')
    }
    if (existing.used) {
      // Code replay → cascade
      await revokeFamily(existing.family_id, 'code_reuse')
      logOauthEvent({
        event: OAUTH_EVENTS.AUTHORIZATION_CODE_REUSED,
        userId: existing.user_id,
        event3: event,
        metadata: {
          client_id: existing.client_id,
          family_id: existing.family_id,
          resource: existing.resource
        }
      })
      return tokenError(event, 400, 'invalid_grant', 'Authorization code replay detected')
    }
    return tokenError(event, 400, 'invalid_grant', 'Code expired or invalid')
  }

  // Phase 2 — validate (code is already spent; no validation failure reverts it)
  if (claimed.client_id !== clientId) {
    // Wrong-client at code redemption is a compromise signal — somebody
    // other than the intended client got hold of the code. Cascade the
    // family eagerly to mirror the refresh path's wrong_client handling
    // (see handleRefreshTokenGrant). Not strictly required (the legitimate
    // client's later attempt would trip the replay path), but symmetric
    // and faster.
    await revokeFamily(claimed.family_id, 'wrong_client')
    logOauthEvent({
      event: OAUTH_EVENTS.AUTHORIZATION_CODE_REUSED,
      userId: claimed.user_id,
      event3: event,
      metadata: {
        family_id: claimed.family_id,
        reason: 'wrong_client',
        expected_client: claimed.client_id,
        presented_client: clientId
      }
    })
    return tokenError(event, 400, 'invalid_grant', 'client_id mismatch')
  }

  const client = await db
    .selectFrom('oauth_clients')
    .select(['enabled'])
    .where('client_id', '=', clientId)
    .executeTakeFirst()
  if (!client?.enabled) {
    return tokenError(event, 400, 'invalid_grant', 'client disabled')
  }

  if (claimed.redirect_uri !== redirectUri) {
    return tokenError(event, 400, 'invalid_grant', 'redirect_uri mismatch')
  }
  if (claimed.resource !== resource || resource !== cfg.mcpResource) {
    return tokenError(event, 400, 'invalid_target', 'resource mismatch')
  }
  if (!isValidPkceVerifier(codeVerifier)) {
    return tokenError(event, 400, 'invalid_grant', 'code_verifier malformed')
  }
  const computedChallenge = s256Challenge(codeVerifier)
  if (!constantTimeEqual(computedChallenge, claimed.code_challenge)) {
    return tokenError(event, 400, 'invalid_grant', 'PKCE verification failed')
  }

  // Re-check user still exists, is verified, and still holds RBAC permissions
  const user = await db
    .selectFrom('users')
    .select(['id', 'verified'])
    .where('id', '=', claimed.user_id)
    .executeTakeFirst()
  if (!user || !user.verified) {
    return tokenError(event, 400, 'invalid_grant', 'User no longer valid')
  }

  const userPerms = await getUserPermissionsAcrossOrgs(claimed.user_id)
  const originalScopes = parseScopeString(claimed.scope)
  const grantedScopes = filterScopesByPermissions(originalScopes, userPerms)
  if (grantedScopes.length !== originalScopes.length) {
    logOauthEvent({
      event: OAUTH_EVENTS.SCOPE_REDUCED,
      userId: claimed.user_id,
      event3: event,
      metadata: {
        client_id: claimed.client_id,
        requested: originalScopes.join(' '),
        granted: grantedScopes.join(' '),
        stage: 'token_exchange'
      }
    })
  }
  if (!hasAnyPermissionScope(grantedScopes)) {
    return tokenError(event, 400, 'invalid_grant', 'No scope survives RBAC check')
  }

  // Phase 3 — issue tokens with family-revocation guard
  const accessPlain = newAccessToken()
  const refreshPlain = grantedScopes.includes(OFFLINE_ACCESS_SCOPE) ? newRefreshToken() : null

  try {
    await db.transaction().execute(async (trx) => {
      const family = await trx
        .selectFrom('oauth_token_families')
        .select(['revoked'])
        .where('family_id', '=', claimed.family_id)
        .forUpdate()
        .executeTakeFirst()

      if (!family) {
        throw new TokenIssuanceError('family_missing')
      }
      if (family.revoked) {
        throw new TokenIssuanceError('family_revoked')
      }

      const accessRow = await trx
        .insertInto('oauth_access_tokens')
        .values({
          token_hash: sha256Hex(accessPlain),
          client_id: clientId,
          user_id: claimed.user_id,
          scope: grantedScopes.join(' '),
          resource,
          family_id: claimed.family_id,
          expires: sql<Date>`now() + interval '${sql.raw(String(cfg.accessTokenTtl))} seconds'`
        })
        .returning(['id'])
        .executeTakeFirstOrThrow()

      if (refreshPlain) {
        await trx
          .insertInto('oauth_refresh_tokens')
          .values({
            token_hash: sha256Hex(refreshPlain),
            client_id: clientId,
            user_id: claimed.user_id,
            scope: grantedScopes.join(' '),
            resource,
            family_id: claimed.family_id,
            rotated_from_id: null,
            access_token_id: accessRow.id,
            expires: sql<Date>`now() + interval '${sql.raw(String(cfg.refreshTokenTtl))} seconds'`
          })
          .execute()
      }
    })
  } catch (err) {
    if (err instanceof TokenIssuanceError && err.code === 'family_revoked') {
      logOauthEvent({
        event: OAUTH_EVENTS.TOKEN_ISSUANCE_ABORTED_FAMILY_REVOKED,
        userId: claimed.user_id,
        event3: event,
        metadata: { family_id: claimed.family_id, grant: 'authorization_code' }
      })
      return tokenError(event, 400, 'invalid_grant', 'token family revoked')
    }
    throw err
  }

  logOauthEvent({
    event: OAUTH_EVENTS.TOKEN_ISSUED,
    userId: claimed.user_id,
    event3: event,
    metadata: {
      client_id: clientId,
      grant: 'authorization_code',
      scope: grantedScopes.join(' '),
      resource,
      family_id: claimed.family_id
    }
  })

  setNoCache(event)
  const response: Record<string, string | number> = {
    access_token: accessPlain,
    token_type: 'Bearer',
    expires_in: cfg.accessTokenTtl,
    scope: grantedScopes.join(' ')
  }
  if (refreshPlain) response.refresh_token = refreshPlain
  return response
}

// ──────────────────────────────────────────────────────────
// refresh_token grant
// ──────────────────────────────────────────────────────────

async function handleRefreshTokenGrant(event: H3Event, cfg: ReturnType<typeof getOauthConfig>, params: Record<string, string>) {
  const refreshToken = params.refresh_token
  const clientId = params.client_id!
  const resource = params.resource!

  if (!refreshToken) return tokenError(event, 400, 'invalid_request', 'refresh_token is required')

  const tokenHash = sha256Hex(refreshToken)

  // Phase 1 — atomic claim
  const claimed = await db
    .updateTable('oauth_refresh_tokens')
    .set({ used: true })
    .where('token_hash', '=', tokenHash)
    .where('used', '=', false)
    .where('revoked', '=', false)
    .where('expires', '>', sql<Date>`now()`)
    .returningAll()
    .executeTakeFirst()

  if (!claimed) {
    const existing = await db
      .selectFrom('oauth_refresh_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst()

    if (!existing) {
      return tokenError(event, 400, 'invalid_grant', 'refresh token not found')
    }
    if (existing.used || existing.revoked) {
      await revokeFamily(existing.family_id, 'refresh_reuse')
      logOauthEvent({
        event: OAUTH_EVENTS.REFRESH_REUSED,
        userId: existing.user_id,
        event3: event,
        metadata: {
          client_id: existing.client_id,
          family_id: existing.family_id,
          reason: existing.revoked ? 'refresh_reuse_after_revoke' : 'refresh_reuse'
        }
      })
      return tokenError(event, 400, 'invalid_grant', 'refresh token replay detected')
    }
    return tokenError(event, 400, 'invalid_grant', 'refresh token expired')
  }

  // Family must not be revoked (admin revoke out of band)
  const family = await db
    .selectFrom('oauth_token_families')
    .select(['revoked'])
    .where('family_id', '=', claimed.family_id)
    .executeTakeFirst()
  if (!family || family.revoked) {
    return tokenError(event, 400, 'invalid_grant', 'token family revoked')
  }

  // Phase 2 — validate
  if (claimed.client_id !== clientId) {
    // Wrong-client → treat as compromise, cascade
    await revokeFamily(claimed.family_id, 'wrong_client')
    logOauthEvent({
      event: OAUTH_EVENTS.REFRESH_REUSED,
      userId: claimed.user_id,
      event3: event,
      metadata: {
        family_id: claimed.family_id,
        reason: 'wrong_client',
        expected_client: claimed.client_id,
        presented_client: clientId
      }
    })
    return tokenError(event, 400, 'invalid_grant', 'client_id mismatch')
  }

  const client = await db
    .selectFrom('oauth_clients')
    .select(['enabled'])
    .where('client_id', '=', clientId)
    .executeTakeFirst()
  if (!client?.enabled) {
    // Disable is admin-side, not compromise — do not cascade
    return tokenError(event, 400, 'invalid_grant', 'client disabled')
  }

  if (claimed.resource !== resource || resource !== cfg.mcpResource) {
    await revokeFamily(claimed.family_id, 'wrong_resource')
    logOauthEvent({
      event: OAUTH_EVENTS.REFRESH_REUSED,
      userId: claimed.user_id,
      event3: event,
      metadata: { family_id: claimed.family_id, reason: 'wrong_resource' }
    })
    return tokenError(event, 400, 'invalid_target', 'resource mismatch')
  }

  const user = await db
    .selectFrom('users')
    .select(['verified'])
    .where('id', '=', claimed.user_id)
    .executeTakeFirst()
  if (!user || !user.verified) {
    return tokenError(event, 400, 'invalid_grant', 'user no longer valid')
  }

  const userPerms = await getUserPermissionsAcrossOrgs(claimed.user_id)
  const originalScopes = parseScopeString(claimed.scope)
  const grantedScopes = filterScopesByPermissions(originalScopes, userPerms)
  if (grantedScopes.length !== originalScopes.length) {
    logOauthEvent({
      event: OAUTH_EVENTS.SCOPE_REDUCED,
      userId: claimed.user_id,
      event3: event,
      metadata: {
        client_id: claimed.client_id,
        requested: originalScopes.join(' '),
        granted: grantedScopes.join(' '),
        stage: 'refresh'
      }
    })
  }
  if (!hasAnyPermissionScope(grantedScopes)) {
    return tokenError(event, 400, 'invalid_grant', 'no scope survives RBAC check')
  }

  // Phase 3 — issue rotated pair
  const accessPlain = newAccessToken()
  const refreshPlain = newRefreshToken()

  try {
    await db.transaction().execute(async (trx) => {
      const fam = await trx
        .selectFrom('oauth_token_families')
        .select(['revoked'])
        .where('family_id', '=', claimed.family_id)
        .forUpdate()
        .executeTakeFirst()

      if (!fam || fam.revoked) {
        throw new TokenIssuanceError('family_revoked')
      }

      const accessRow = await trx
        .insertInto('oauth_access_tokens')
        .values({
          token_hash: sha256Hex(accessPlain),
          client_id: clientId,
          user_id: claimed.user_id,
          scope: grantedScopes.join(' '),
          resource,
          family_id: claimed.family_id,
          expires: sql<Date>`now() + interval '${sql.raw(String(cfg.accessTokenTtl))} seconds'`
        })
        .returning(['id'])
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('oauth_refresh_tokens')
        .values({
          token_hash: sha256Hex(refreshPlain),
          client_id: clientId,
          user_id: claimed.user_id,
          scope: grantedScopes.join(' '),
          resource,
          family_id: claimed.family_id,
          rotated_from_id: claimed.id,
          access_token_id: accessRow.id,
          expires: sql<Date>`now() + interval '${sql.raw(String(cfg.refreshTokenTtl))} seconds'`
        })
        .execute()
    })
  } catch (err) {
    if (err instanceof TokenIssuanceError && err.code === 'family_revoked') {
      logOauthEvent({
        event: OAUTH_EVENTS.TOKEN_ISSUANCE_ABORTED_FAMILY_REVOKED,
        userId: claimed.user_id,
        event3: event,
        metadata: { family_id: claimed.family_id, grant: 'refresh_token' }
      })
      return tokenError(event, 400, 'invalid_grant', 'token family revoked')
    }
    throw err
  }

  logOauthEvent({
    event: OAUTH_EVENTS.REFRESH_ROTATED,
    userId: claimed.user_id,
    event3: event,
    metadata: {
      client_id: clientId,
      family_id: claimed.family_id,
      scope: grantedScopes.join(' ')
    }
  })

  setNoCache(event)
  return {
    access_token: accessPlain,
    token_type: 'Bearer',
    expires_in: cfg.accessTokenTtl,
    refresh_token: refreshPlain,
    scope: grantedScopes.join(' ')
  }
}

class TokenIssuanceError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}
