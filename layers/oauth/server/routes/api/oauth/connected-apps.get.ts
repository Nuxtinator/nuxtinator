// Lists OAuth grants the authenticated user has approved.
//
// Surfaces what's needed by the user's "Connected apps" UI: the
// client name, when it was granted, what permissions it carries (with
// their titles), when it was last used, and whether any tokens are still
// live.
// Revoked consents are filtered out — once a user revokes, the row
// stays in the DB for audit but disappears from this listing.

import { sql } from 'kysely'
import { requireAuth } from '#core/server/utils/auth'
import { runInOrgTransaction } from '#tenant/server'
import { oauthScopeLabel } from '../../../utils/oauth-scope-labels'

export default defineEventHandler(async (event) => {
  const user = requireAuth(event)

  // RLS-scoped in multi mode — the user only sees consents granted in their
  // currently-active org. Single mode: plain transaction over global table.
  const consents = await runInOrgTransaction(event, async tx => tx
    .selectFrom('oauth_consents')
    .leftJoin('oauth_clients', 'oauth_clients.client_id', 'oauth_consents.client_id')
    .select([
      'oauth_consents.client_id as client_id',
      'oauth_consents.scope as scope',
      'oauth_consents.created as granted_at',
      'oauth_clients.client_name as client_name',
      'oauth_clients.dynamic as dynamic',
      // Latest access-token use across any non-revoked, non-expired
      // token for this user+client. Subquery so the join doesn't
      // multiply rows.
      eb => eb
        .selectFrom('oauth_access_tokens')
        .select(eb2 => eb2.fn.max('oauth_access_tokens.last_used').as('last_used_at'))
        .whereRef('oauth_access_tokens.user_id', '=', 'oauth_consents.user_id')
        .whereRef('oauth_access_tokens.client_id', '=', 'oauth_consents.client_id')
        .where('oauth_access_tokens.revoked', '=', false)
        .as('last_used_at'),
      // Boolean: any token live right now (not revoked + not expired).
      eb => eb
        .selectFrom('oauth_access_tokens')
        .select(eb2 => eb2.fn.count<string>('oauth_access_tokens.token_hash').as('count'))
        .whereRef('oauth_access_tokens.user_id', '=', 'oauth_consents.user_id')
        .whereRef('oauth_access_tokens.client_id', '=', 'oauth_consents.client_id')
        .where('oauth_access_tokens.revoked', '=', false)
        .where('oauth_access_tokens.expires', '>', sql<Date>`now()`)
        .as('active_token_count')
    ])
    .where('oauth_consents.user_id', '=', user.userId)
    .where('oauth_consents.revoked', '=', false)
    .orderBy('oauth_consents.created', 'desc')
    .execute())

  // Merge multi-resource rows by client_id (rare, but possible).
  const byClient = new Map<string, {
    client_id: string
    client_name: string
    dynamic: boolean
    scope: string
    granted_at: string
    last_used_at: string | null
    has_active_tokens: boolean
  }>()

  for (const row of consents) {
    const existing = byClient.get(row.client_id)
    const scopes = new Set<string>((existing?.scope ?? '').split(/\s+/).filter(Boolean))
    for (const s of String(row.scope ?? '').split(/\s+/).filter(Boolean)) scopes.add(s)
    const grantedAtMs = new Date(row.granted_at as unknown as string).getTime()
    const newer = !existing || grantedAtMs < new Date(existing.granted_at).getTime()
      ? row.granted_at
      : existing.granted_at
    const lastUsedMs = row.last_used_at ? new Date(row.last_used_at as unknown as string).getTime() : null
    const existingLastUsed = existing?.last_used_at ? new Date(existing.last_used_at).getTime() : null
    const lastUsed = (() => {
      if (lastUsedMs === null) return existingLastUsed
      if (existingLastUsed === null) return lastUsedMs
      return Math.max(lastUsedMs, existingLastUsed)
    })()
    const activeTokens = Number(row.active_token_count ?? 0) > 0 || (existing?.has_active_tokens ?? false)

    byClient.set(row.client_id, {
      client_id: row.client_id,
      client_name: row.client_name ?? row.client_id,
      dynamic: Boolean(row.dynamic),
      scope: Array.from(scopes).join(' '),
      granted_at: new Date(newer as unknown as string).toISOString(),
      last_used_at: lastUsed === null ? null : new Date(lastUsed).toISOString(),
      has_active_tokens: activeTokens
    })
  }

  return {
    apps: Array.from(byClient.values()).map(app => ({
      ...app,
      scopes: app.scope.split(' ').filter(Boolean).map(oauthScopeLabel)
    }))
  }
})
