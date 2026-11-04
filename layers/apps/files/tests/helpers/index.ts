// Files-layer test helpers. Re-exports tenancy + core helpers, adds helpers
// for seeding files_* rows and cleaning up. All seeded data is prefixed
// `test-files-` (users, orgs) so cleanup stays scoped.
import type postgres from 'postgres'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect } from 'vitest'
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

export async function createFilesUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-files-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createFilesOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-files-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? 'Test Files Org'
  })
}

// Org + a user with the given roles (default admin → every registered perm).
export async function createFilesOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createFilesUser(sql)
  const org = await createFilesOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

export async function addFilesMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createFilesUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

// Seed a doc item + its initial version directly (BYPASSRLS). Multi-tenant
// mode needs org_id on every files_* row.
export async function createTestDoc(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, created_by: string, title?: string, body_md?: string }
): Promise<{ id: string }> {
  const id = randomUUID()
  const title = opts.title ?? `test-files-doc-${randomUUID().slice(0, 8)}`
  const body = opts.body_md ?? '# Hello\n\nseed body'
  await sql`
    INSERT INTO files_items (id, kind, title, body_md, created_by, last_edited_by, org_id)
    VALUES (${id}, 'doc', ${title}, ${body}, ${opts.created_by}, ${opts.created_by}, ${opts.org_id})
  `
  await sql`
    INSERT INTO files_versions (item_id, title, content, edited_by, org_id)
    VALUES (${id}, ${title}, ${body}, ${opts.created_by}, ${opts.org_id})
  `
  return { id }
}

// Seed a site item (self-contained HTML in body_md) + its initial version.
export async function createTestSite(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, created_by: string, title?: string, html?: string }
): Promise<{ id: string }> {
  const id = randomUUID()
  const title = opts.title ?? `test-files-site-${randomUUID().slice(0, 8)}`
  const html = opts.html ?? '<!doctype html><html><body><h1>seed site</h1></body></html>'
  await sql`
    INSERT INTO files_items (id, kind, title, body_md, created_by, last_edited_by, org_id)
    VALUES (${id}, 'site', ${title}, ${html}, ${opts.created_by}, ${opts.created_by}, ${opts.org_id})
  `
  await sql`
    INSERT INTO files_versions (item_id, title, content, edited_by, org_id)
    VALUES (${id}, ${title}, ${html}, ${opts.created_by}, ${opts.org_id})
  `
  return { id }
}

// Seed a file item. storage_key can be fake — generateSignedUrl only builds a
// presigned URL string and doesn't verify the object exists.
export async function createTestFile(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, created_by: string, title?: string, filename?: string, mime?: string }
): Promise<{ id: string }> {
  const id = randomUUID()
  const filename = opts.filename ?? 'seed.bin'
  await sql`
    INSERT INTO files_items (id, kind, title, storage_key, filename, mime, size_bytes, created_by, org_id)
    VALUES (${id}, 'file', ${opts.title ?? filename}, ${`uploads/${id}.bin`}, ${filename},
            ${opts.mime ?? 'application/octet-stream'}, 1234, ${opts.created_by}, ${opts.org_id})
  `
  return { id }
}

// Read an item's share_token directly (BYPASSRLS) for public-route tests.
export async function getShareToken(
  sql: ReturnType<typeof postgres>,
  id: string
): Promise<string | null> {
  const rows = await sql`SELECT share_token FROM files_items WHERE id = ${id}`
  return (rows[0]?.share_token as string | null) ?? null
}

// --- MCP over the real /mcp transport ---

export interface McpToolResult {
  content: Array<{ type: string, text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

// Mint an oauth client + token family + access token with the same row shapes
// the token endpoint writes. The token's resource must equal the server's
// mcpResource, read from its RFC 9728 metadata. The client id is
// `test-files-` prefixed so cleanup can scope its delete.
export async function issueMcpBearer(
  sql: ReturnType<typeof postgres>,
  userId: string,
  scopes: string[]
): Promise<string> {
  const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
  const meta = await metaRes.json() as { resource: string }
  const clientId = `test-files-${randomBytes(8).toString('hex')}`
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
    VALUES (${clientId}, 'test-files mcp client', ${['http://localhost/callback']})
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
  return token
}

// One JSON-RPC tools/call over Streamable HTTP. The stateless transport
// answers with an SSE frame; unwrap the data line to the tool result.
export async function callMcpTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult> {
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
  expect(res.status, text).toBe(200)
  const dataLine = text.trim().split('\n').find(l => l.startsWith('data:'))
  const rpc = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : text) as { result?: McpToolResult, error?: unknown }
  expect(rpc.error, JSON.stringify(rpc.error)).toBeUndefined()
  return rpc.result!
}

export async function cleanupFilesTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    DELETE FROM files_versions
    WHERE item_id IN (
      SELECT id FROM files_items
      WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
    )
  `
  await sql`
    DELETE FROM files_items
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-files-%' OR slug LIKE 'test-tenancy-%'`
  await sql`DELETE FROM activity_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')`
  await sql`DELETE FROM users WHERE email LIKE 'test-files-%@example.com'`
  // Clients minted by issueMcpBearer; their tokens cascade off the users above.
  await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-files-%'`
}
