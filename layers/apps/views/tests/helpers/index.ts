// Views-layer test helpers. Re-exports tenancy + core helpers and adds
// org/user bootstrap with the `test-views-` prefix plus prefix-scoped
// cleanup. views_definitions.owner_id is ON DELETE RESTRICT, so views are
// wiped explicitly before users; shares and card placements cascade off the
// view row.
import type postgres from 'postgres'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { url as nuxtUrl } from '@nuxt/test-utils/e2e'
import {
  createTestUser,
  getAuthHeaders,
  type AuthHeaders,
  type TestUser,
  createTestOrg,
  addTestMembership,
  type TestOrg
} from '@nuxtinator/tenancy/test-helpers'

export * from '@nuxtinator/tenancy/test-helpers'

export async function createViewsUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-views-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createViewsOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-views-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? 'Test Views Org'
  })
}

// Complete org + user with the given roles. Default `admin` gets every
// registered permission via the admin special-case in rbac.ts.
export async function createViewsOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin'],
  userOpts: Parameters<typeof createTestUser>[1] = {}
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createViewsUser(sql, userOpts)
  const org = await createViewsOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

export async function addViewsMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createViewsUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

/**
 * Org-scoped custom role carrying exactly the given permission slugs — the
 * tool for callers that must hold `views.use` but no CRM write access.
 */
export async function createViewsRole(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  permissions: string[]
): Promise<string> {
  const name = `test-views-role-${randomUUID().slice(0, 8)}`
  await sql`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'scoped perms for tests', ${permissions}::text[], ${orgId})
  `
  return name
}

export interface McpToolResult {
  content: Array<{ type: string, text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

// Mint an oauth client + token family + access token with the same row shapes
// the token endpoint writes. The token's resource must equal the server's
// mcpResource, read from its RFC 9728 metadata.
export async function issueMcpBearer(
  sql: ReturnType<typeof postgres>,
  userId: string,
  scopes: string[]
): Promise<{ token: string, clientId: string }> {
  const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
  const meta = await metaRes.json() as { resource: string }
  const clientId = `test-views-${randomBytes(8).toString('hex')}`
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
    VALUES (${clientId}, 'test-views mcp client', ${['http://localhost/callback']})
  `
  const familyId = randomUUID()
  await sql`
    INSERT INTO oauth_token_families (family_id, user_id, client_id)
    VALUES (${familyId}, ${userId}, ${clientId})
  `
  const token = `oat_${randomBytes(32).toString('hex')}`
  const tokenHash = createHash('sha256').update(token).digest('hex')
  await sql`
    INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, resource, family_id, expires)
    VALUES (${tokenHash}, ${clientId}, ${userId}, ${scopes.join(' ')}, ${meta.resource}, ${familyId}, now() + interval '1 hour')
  `
  return { token, clientId }
}

// One tools/call over Streamable HTTP. The stateless transport answers with
// an SSE frame; unwrap the data line to the result.
export async function callMcpTool(token: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const res = await fetch(nuxtUrl('/mcp'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`MCP tools/call returned ${res.status}: ${text}`)
  const dataLine = text.trim().split('\n').find(l => l.startsWith('data:'))
  const rpc = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : text) as { result?: McpToolResult, error?: unknown }
  if (rpc.error) throw new Error(`MCP tools/call error: ${JSON.stringify(rpc.error)}`)
  return rpc.result!
}

export async function cleanupViewsTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  // Scoped strictly to this layer's own prefix: projects run in parallel,
  // and a broader 'test-%' sweep here would delete other projects' records
  // out from under their in-flight tests.
  await sql`
    DELETE FROM views_definitions
    WHERE owner_id IN (SELECT id FROM users WHERE email LIKE 'test-views-%@example.com')
  `
  await sql`
    DELETE FROM records_entries
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-views-%@example.com')
  `
  // Orgs cascade memberships, org_apps, custom roles, and org-scoped rows.
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-views-%'`
  await sql`
    DELETE FROM activity_logs
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-views-%@example.com')
  `
  await sql`DELETE FROM users WHERE email LIKE 'test-views-%@example.com'`
  // Clients minted by issueMcpBearer; their tokens cascade off the users above.
  await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-views-%'`
}
