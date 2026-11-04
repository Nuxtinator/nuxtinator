// Adds the OAuth tables to the host schema by merging into core's global
// `NuxtinatorDatabaseTables` registry. Global interface merging is
// resolution-independent, so it works whether `#core` resolves via a workspace
// symlink, an npm package, or a `_layers/` path alias in a downstream host.
import type { ColumnType, Generated } from 'kysely'

export interface OauthClientsTable {
  id: Generated<string>
  created: ColumnType<Date, Date | string | undefined, Date | string>
  updated: ColumnType<Date, Date | string | undefined, Date | string>
  client_id: string
  client_name: string
  redirect_uris: string[]
  grant_types: Generated<string[]>
  token_endpoint_auth_method: Generated<string>
  scope: Generated<string>
  dynamic: Generated<boolean>
  enabled: Generated<boolean>
  created_by: string | null
}

export interface OauthTokenFamiliesTable {
  family_id: string
  user_id: string
  client_id: string
  revoked: Generated<boolean>
  revoked_reason: string | null
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  created: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface OauthPendingRequestsTable {
  id: Generated<string>
  created: ColumnType<Date, Date | string | undefined, Date | string>
  expires: ColumnType<Date, Date | string, Date | string>
  client_id: string
  user_id: string
  redirect_uri: string
  scope: string
  resource: string
  state: string | null
  code_challenge: string
  csrf_token_hash: string
  consumed: Generated<boolean>
}

export interface OauthAuthorizationCodesTable {
  code_hash: string
  client_id: string
  user_id: string
  redirect_uri: string
  scope: string
  resource: string
  code_challenge: string
  family_id: string
  expires: ColumnType<Date, Date | string, Date | string>
  used: Generated<boolean>
  created: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface OauthAccessTokensTable {
  token_hash: string
  id: Generated<string>
  client_id: string
  user_id: string
  scope: string
  resource: string
  family_id: string
  expires: ColumnType<Date, Date | string, Date | string>
  revoked: Generated<boolean>
  revoked_reason: string | null
  created: ColumnType<Date, Date | string | undefined, Date | string>
  last_used: ColumnType<Date | null, Date | string | null, Date | string | null>
}

export interface OauthRefreshTokensTable {
  token_hash: string
  id: Generated<string>
  client_id: string
  user_id: string
  scope: string
  resource: string
  family_id: string
  rotated_from_id: string | null
  access_token_id: string | null
  expires: ColumnType<Date, Date | string, Date | string>
  used: Generated<boolean>
  revoked: Generated<boolean>
  revoked_reason: string | null
  created: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface OauthConsentsTable {
  id: Generated<string>
  created: ColumnType<Date, Date | string | undefined, Date | string>
  updated: ColumnType<Date, Date | string | undefined, Date | string>
  client_id: string
  user_id: string
  resource: string
  scope: string
  // Scopes the user turned down (migration oauth_002).
  declined_scope: Generated<string>
  revoked: Generated<boolean>
}

declare global {
  interface NuxtinatorDatabaseTables {
    oauth_clients: OauthClientsTable
    oauth_token_families: OauthTokenFamiliesTable
    oauth_pending_requests: OauthPendingRequestsTable
    oauth_authorization_codes: OauthAuthorizationCodesTable
    oauth_access_tokens: OauthAccessTokensTable
    oauth_refresh_tokens: OauthRefreshTokensTable
    oauth_consents: OauthConsentsTable
  }
}
