// OAuth access tokens for tests of routes that accept them. Needs the oauth
// layer in the test build (the dev host loads it). Clients are prefixed
// `test-oauth-` so `cleanupTestOauthClients` can find them.
import type postgres from 'postgres'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { $fetch } from '@nuxt/test-utils/e2e'
import type { TestUser } from './auth'

export interface TestOauthToken {
  token: string
  clientId: string
  familyId: string
}

let resource: string | null = null

// The audience the server issues tokens for.
export async function getOauthResource(): Promise<string> {
  resource ??= (await $fetch<{ resource: string }>('/.well-known/oauth-protected-resource')).resource
  return resource
}

export async function createTestOauthClient(
  sql: ReturnType<typeof postgres>,
  opts: { scopes?: string[], redirectUri?: string } = {}
): Promise<string> {
  const clientId = `test-oauth-${randomUUID().slice(0, 8)}`
  const redirectUris = [opts.redirectUri ?? 'http://127.0.0.1:9/callback']
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris, scope, dynamic)
    VALUES (${clientId}, ${`Test client ${clientId}`}, ${redirectUris}, ${(opts.scopes ?? []).join(' ')}, false)
  `
  return clientId
}

export async function createTestOauthToken(
  sql: ReturnType<typeof postgres>,
  user: TestUser,
  scopes: string[],
  opts: { clientId?: string, refresh?: boolean } = {}
): Promise<TestOauthToken & { refreshToken: string | null }> {
  const clientId = opts.clientId ?? await createTestOauthClient(sql, { scopes })
  const familyId = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const scope = scopes.join(' ')
  const aud = await getOauthResource()
  await sql`INSERT INTO oauth_token_families (family_id, user_id, client_id) VALUES (${familyId}, ${user.id}, ${clientId})`
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, resource, family_id, expires)
    VALUES (${createHash('sha256').update(token).digest('hex')}, ${clientId}, ${user.id}, ${scope}, ${aud}, ${familyId}, now() + interval '1 hour')
    RETURNING id
  `
  let refreshToken: string | null = null
  if (opts.refresh) {
    refreshToken = randomBytes(32).toString('base64url')
    await sql`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, resource, family_id, access_token_id, expires)
      VALUES (${createHash('sha256').update(refreshToken).digest('hex')}, ${clientId}, ${user.id}, ${scope}, ${aud}, ${familyId}, ${access!.id}, now() + interval '30 days')
    `
  }
  return { token, clientId, familyId, refreshToken }
}

export function bearer(token: string, headers: Record<string, string> = {}): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${token}`, ...headers } }
}

export async function cleanupTestOauthClients(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DELETE FROM activity_logs WHERE client_id LIKE 'test-oauth-%' OR metadata->>'client_id' LIKE 'test-oauth-%'`
  for (const table of ['oauth_refresh_tokens', 'oauth_access_tokens', 'oauth_authorization_codes', 'oauth_consents', 'oauth_pending_requests', 'oauth_token_families']) {
    await sql`DELETE FROM ${sql(table)} WHERE client_id LIKE 'test-oauth-%'`
  }
  await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-oauth-%'`
}
