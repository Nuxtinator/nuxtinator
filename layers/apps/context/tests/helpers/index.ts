// Context-layer test helpers. Re-exports tenancy + core helpers (so other
// layers / future suites can import them all from one place) and adds
// helpers for seeding context_* rows and cleaning up.
//
// All seeded data is prefixed `test-context-` (users, org slugs, portfolio
// slugs) so `cleanupContextTestData` can scope deletes by ownership of the
// rows. Cleanup runs orgs → users last so cascade FKs unwind portfolios,
// sections, comments, etc.
import type postgres from 'postgres'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { $fetch, url as nuxtUrl } from '@nuxt/test-utils/e2e'
import {
  createTestUser,
  getAuthHeaders,
  type AuthHeaders,
  type TestUser,
  createTestOrg,
  addTestMembership,
  type TestOrg
} from '@nuxtinator/tenancy/test-helpers'

import { CONTEXT_SECTIONS } from '../../server/utils/section-catalog'

export * from '@nuxtinator/tenancy/test-helpers'

// --- The AI fake ---
//
// Under VITEST the AI layer routes every model call to a primeable fake and
// exposes it at `/api/_test/ai`. Assistant tests script the next reply (and
// any tool calls the model "makes") and read back what it was asked.

export interface AiFakeScript {
  // Text a streaming reply shows before its tool calls and then discards.
  discardedText?: string
  text?: string
  toolCalls?: Array<{ name: string, input: Record<string, unknown> }>
}

export interface AiFakeCall {
  kind: 'complete' | 'generate'
  model: string
  system: string | undefined
  messages: Array<{ role: string, content: string }>
  tools: string[]
  toolResults: Array<{ name: string, input: Record<string, unknown>, result: string }>
  streamed?: boolean
  subject?: string | null
}

export async function primeAiFake(script: AiFakeScript): Promise<void> {
  await $fetch('/api/_test/ai', { method: 'POST', body: script })
}

export async function getAiFakeLog(): Promise<AiFakeCall[]> {
  return await $fetch<AiFakeCall[]>('/api/_test/ai')
}

export async function resetAiFake(): Promise<void> {
  await $fetch('/api/_test/ai', { method: 'DELETE' })
}

// Render a section-update block the way the assistant prompt asks the model
// to, so a primed reply exercises the real parser.
export function sectionUpdateBlock(u: { portfolio?: string, section_key: string, section_title: string, content: string }): string {
  return '```section-update\n'
    + (u.portfolio ? `PORTFOLIO: ${u.portfolio}\n` : '')
    + `SECTION_KEY: ${u.section_key}\n`
    + `SECTION_TITLE: ${u.section_title}\n`
    + '---\n'
    + `${u.content}\n`
    + '```'
}

// Users / orgs are tagged with `test-context-` so per-layer cleanup stays
// scoped. Anything tagged `test-tenancy-` or `test-core-` is owned by other
// layers and left alone here.
export async function createContextUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-context-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createContextOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-context-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? `Test Context Org`
  })
}

// Build a complete org with a user that has the given roles. Default role is
// `admin` so the user gets every registered permission via the admin
// special-case in rbac.ts.
export async function createContextOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createContextUser(sql)
  const org = await createContextOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

// Add another user to an existing org, returning the user + auth bundle.
export async function addContextMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createContextUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

// Seed a portfolio directly via the host-admin pool (BYPASSRLS). Multi-tenant
// retrofit adds `org_id NOT NULL DEFAULT current_org_id()` — but the GUC isn't
// set outside `defineTenantHandler`'s txn, so the seed must supply org_id
// explicitly to satisfy NOT NULL. Seeds the built-in section rows too
// (`builtin_sections` narrows the set; [] = none), as the create route does.
export interface TestPortfolio {
  id: string
  slug: string
  name: string
}

export async function createTestPortfolio(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, slug?: string, name?: string, created_by?: string, builtin_sections?: string[] }
): Promise<TestPortfolio> {
  const id = randomUUID()
  const slug = opts.slug ?? `test-context-${randomUUID().slice(0, 8)}`
  const name = opts.name ?? 'Test Portfolio'
  await sql`
    INSERT INTO context_portfolios (id, slug, name, org_id)
    VALUES (${id}, ${slug}, ${name}, ${opts.org_id})
  `
  const keys = opts.builtin_sections ?? CONTEXT_SECTIONS.map(s => s.key)
  for (const key of keys) {
    await sql`
      INSERT INTO context_section_definitions (portfolio_id, key, created_by)
      VALUES (${id}, ${key}, ${opts.created_by ?? null})
    `
  }
  return { id, slug, name }
}

// Seed a section directly. Used by tests that exercise read-side endpoints
// without going through the PUT endpoint as setup.
export async function seedTestSection(
  sql: ReturnType<typeof postgres>,
  opts: { portfolio_id: string, section_key: string, content?: string, last_edited_by?: string | null }
): Promise<{ id: string }> {
  const id = randomUUID()
  const content = opts.content ?? ''
  await sql`
    INSERT INTO context_sections (id, portfolio_id, section_key, content, last_edited_by)
    VALUES (${id}, ${opts.portfolio_id}, ${opts.section_key}, ${content}, ${opts.last_edited_by ?? null})
  `
  return { id }
}

// Seed a custom section definition. Used by catalog ordering + isolation tests.
export async function seedTestCustomSection(
  sql: ReturnType<typeof postgres>,
  opts: { portfolio_id: string, key: string, title: string, description?: string, order?: number, created_by: string }
): Promise<{ id: string }> {
  const id = randomUUID()
  await sql`
    INSERT INTO context_section_definitions
      (id, portfolio_id, key, title, description, "order", created_by, is_custom)
    VALUES (${id}, ${opts.portfolio_id}, ${opts.key}, ${opts.title}, ${opts.description ?? ''}, ${opts.order ?? null}, ${opts.created_by}, true)
  `
  return { id }
}

// --- MCP over the real /mcp transport ---

export interface McpToolResult {
  content: Array<{ type: string, text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

// Mint an oauth client + token family + access token with the same row
// shapes the token endpoint writes. The token's resource must equal the
// server's mcpResource, read from its RFC 9728 metadata so the test doesn't
// depend on the configured site URL. The client id is `test-context-`
// prefixed; callers delete those rows in their own cleanup.
export async function issueMcpBearer(
  sql: ReturnType<typeof postgres>,
  userId: string,
  scopes: string[]
): Promise<string> {
  const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
  const meta = await metaRes.json() as { resource: string }
  const clientId = `test-context-${randomBytes(8).toString('hex')}`
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
    VALUES (${clientId}, 'test-context mcp client', ${['http://localhost/callback']})
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
  expect(res.status, text).toBe(200)
  const dataLine = text.trim().split('\n').find(l => l.startsWith('data:'))
  const rpc = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : text) as { result?: McpToolResult, error?: unknown }
  expect(rpc.error, JSON.stringify(rpc.error)).toBeUndefined()
  return rpc.result!
}

// Wipe every context_* row owned by data this layer's tests created. The
// strategy: context tables CASCADE off context_portfolios; portfolios CASCADE
// off orgs (multi-tenant retrofit); so deleting the portfolio (or its parent
// org) drops everything beneath it.
//
// We over-delete intentionally: any context_* row whose author is a
// test-context-/test-tenancy-/test-core- user is fair game. Activity logs
// authored by those users also get swept.
export async function cleanupContextTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    DELETE FROM context_assistant_conversations
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  // Comment replies cascade off comments, comments cascade off sections,
  // sections cascade off portfolios. Belt-and-braces: explicit deletes for
  // any leak rows whose author/editor is a test user but whose parent
  // portfolio happens to not be test-prefixed.
  await sql`
    DELETE FROM context_section_comment_replies
    WHERE author_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM context_section_comments
    WHERE author_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM context_section_versions
    WHERE edited_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM context_sections
    WHERE last_edited_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM context_section_definitions
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  // Portfolios: by slug prefix and by membership in a test org. CASCADE
  // wipes any remaining sections / comments / replies / customs / versions.
  await sql`
    DELETE FROM context_portfolios
    WHERE slug LIKE 'test-context-%'
       OR org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-%')
  `
  // Orgs created by this layer's tests (cascades into memberships,
  // org_apps, role overrides, any leftover portfolios).
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-context-%'`
  // Activity logs and users authored by this layer's tests.
  await sql`
    DELETE FROM activity_logs
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-context-%@example.com')
  `
  await sql`DELETE FROM users WHERE email LIKE 'test-context-%@example.com'`
}
