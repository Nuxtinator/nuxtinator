// CRM-layer test helpers. Re-exports tenancy + core helpers and adds
// helpers for seeding crm_* rows and cleaning up.
//
// All seeded data is prefixed `test-crm-` (users, org slugs) so
// `cleanupCrmTestData` can scope deletes by ownership of the rows. crm_*
// content cascades off orgs (org_id, multi-tenant retrofit) and off
// crm_records; crm_records.created_by is ON DELETE RESTRICT, so record rows
// are wiped explicitly before users.
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

// Users / orgs are tagged with `test-crm-` so per-layer cleanup stays
// scoped. Anything tagged `test-tenancy-` or `test-core-` is owned by other
// layers and left alone here.
export async function createCrmUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-crm-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createCrmOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-crm-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? 'Test CRM Org'
  })
}

// Build a complete org with a user that has the given roles. Default role is
// `admin` so the user gets every registered permission via the admin
// special-case in rbac.ts.
export async function createCrmOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createCrmUser(sql)
  const org = await createCrmOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

// Add another user to an existing org, returning the user + auth bundle.
export async function addCrmMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createCrmUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

// Seed a contact directly via the host-admin pool (BYPASSRLS), bypassing the
// POST records route. Multi-tenant retrofit adds `org_id NOT NULL DEFAULT
// current_org_id()` — the GUC isn't set outside `defineTenantHandler`'s txn,
// so the seed must supply org_id explicitly. `data` is bound through
// ::text::jsonb — postgres-js double-encodes a pre-stringified param bound
// with a bare ::jsonb cast, storing a jsonb string scalar that degrades the
// doc on the kernel's first `||` merge (dev.md gotcha 1).
export async function createTestContact(
  sql: ReturnType<typeof postgres>,
  opts: {
    org_id: string
    created_by: string
    name?: string
    status?: string | null
    data?: Record<string, unknown>
    record_type?: string
  }
): Promise<{ id: string, name: string }> {
  const id = randomUUID()
  const name = opts.name ?? `test-crm-contact-${randomUUID().slice(0, 8)}`
  await sql`
    INSERT INTO crm_records (id, record_type, name, status, data, created_by, org_id)
    VALUES (${id}, ${opts.record_type ?? 'contacts'}, ${name}, ${opts.status ?? null},
            ${JSON.stringify(opts.data ?? {})}::text::jsonb, ${opts.created_by}, ${opts.org_id})
  `
  return { id, name }
}

// --- MCP --------------------------------------------------------------------

export interface McpToolResult {
  content: Array<{ type: string, text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export const CRM_TEST_MCP_CLIENT_NAME = 'test-crm mcp client'

// Mint an oauth client + token family + access token with the same row shapes
// the token endpoint writes. The token's resource must equal the server's
// mcpResource, read from its RFC 9728 metadata. The client id is
// `test-crm-` prefixed so cleanup can scope its delete.
export async function issueMcpBearer(
  sql: ReturnType<typeof postgres>,
  userId: string,
  scopes: string[]
): Promise<{ token: string, clientId: string }> {
  const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
  const meta = await metaRes.json() as { resource: string }
  const clientId = `test-crm-${randomBytes(8).toString('hex')}`
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
    VALUES (${clientId}, ${CRM_TEST_MCP_CLIENT_NAME}, ${['http://localhost/callback']})
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

// One JSON-RPC request over Streamable HTTP. The stateless transport answers
// with an SSE frame; unwrap the data line to the result.
async function mcpRequest<T>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(nuxtUrl('/mcp'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`MCP ${method} returned ${res.status}: ${text}`)
  const dataLine = text.trim().split('\n').find(l => l.startsWith('data:'))
  const rpc = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : text) as { result?: T, error?: unknown }
  if (rpc.error) throw new Error(`MCP ${method} error: ${JSON.stringify(rpc.error)}`)
  return rpc.result!
}

export async function callMcpTool(token: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  return await mcpRequest<McpToolResult>(token, 'tools/call', { name, arguments: args })
}

export async function listMcpTools(token: string): Promise<Array<{ name: string, annotations?: Record<string, boolean> }>> {
  return (await mcpRequest<{ tools: Array<{ name: string, annotations?: Record<string, boolean> }> }>(token, 'tools/list', {})).tools
}

// Wipe every crm_* row owned by data this layer's tests created.
//
// Order matters: crm_records rows must go before users (created_by is ON
// DELETE RESTRICT); the record delete cascades entries, user refs,
// connections, shares, channel links, activity, and comments. Channels (and
// through them consents, suppressions, events) plus the definition tables
// are org-scoped and go by org. We over-delete intentionally: any crm_records
// row created by a test-prefixed user of any layer is fair game.
export async function cleanupCrmTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    DELETE FROM crm_records
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM crm_consent_events
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-crm-%')
  `
  await sql`
    DELETE FROM crm_channels
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-crm-%')
  `
  await sql`
    DELETE FROM crm_channel_types
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-crm-%')
  `
  await sql`
    DELETE FROM crm_record_fields
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-crm-%')
  `
  await sql`
    DELETE FROM crm_record_types
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-crm-%')
  `
  // Orgs created by this layer's tests (cascades into memberships, org_apps,
  // and any leftover org-scoped crm rows).
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-crm-%'`
  await sql`
    DELETE FROM activity_logs
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-crm-%@example.com')
  `
  await sql`DELETE FROM users WHERE email LIKE 'test-crm-%@example.com'`
  // OAuth clients minted by `issueMcpBearer`; their token families and
  // access tokens cascade off the users deleted above.
  await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-crm-%'`
}
