// Feedback-layer test helpers. Re-exports tenancy + core helpers, adds
// helpers for seeding feedback rows and cleaning up.
//
// All seeded data uses the `test-feedback-` prefix on users / org slugs so
// `cleanupFeedbackTestData` can scope deletes by ownership of the rows.
// Cleanup order matters: feedback_attachments / card_column_history / cards
// FK into projects + swimlanes (CASCADE on project, CASCADE on swimlane),
// and projects + swimlanes + cards + card_column_history + feedback_attachments
// all have an `org_id` FK to orgs (CASCADE) added by feedback_T010. So wiping
// the orgs cascades through everything per-app — but we explicitly DELETE
// the tenant tables first to also catch rows seeded into orgs we no longer own.
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

// Users / orgs are tagged with `test-feedback-` so per-layer cleanup stays
// scoped. Anything tagged `test-tenancy-` or `test-core-` is owned by other
// layers and left alone here.
export async function createFeedbackUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-feedback-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createFeedbackOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-feedback-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? `Test Feedback Org`
  })
}

// Build a complete org with a user that has the given roles. Default role is
// `admin` so the user gets every registered permission via the admin
// special-case in rbac.ts.
export async function createFeedbackOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createFeedbackUser(sql)
  const org = await createFeedbackOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

// Add another user to an existing org, returning the user + auth bundle.
export async function addFeedbackMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createFeedbackUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

// Seed a project + its default swimlane in one shot. Mirrors what the
// POST /api/feedback/projects route does so the rest of the API surface
// works against this seed without round-tripping through the create route
// as test setup.
export async function createTestProject(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, name?: string, description?: string | null }
): Promise<{ id: string, name: string, default_swimlane_id: string }> {
  const id = randomUUID()
  const swimlaneId = randomUUID()
  const name = opts.name ?? `test-feedback-project-${randomUUID().slice(0, 8)}`
  await sql`
    INSERT INTO projects (id, name, description, org_id)
    VALUES (${id}, ${name}, ${opts.description ?? null}, ${opts.org_id})
  `
  await sql`
    INSERT INTO swimlanes (id, project_id, name, is_default, position, org_id)
    VALUES (${swimlaneId}, ${id}, 'default', true, 0, ${opts.org_id})
  `
  return { id, name, default_swimlane_id: swimlaneId }
}

// Seed an extra (non-default) swimlane on a project.
export async function createTestSwimlane(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, project_id: string, name?: string, position?: number }
): Promise<{ id: string, name: string }> {
  const id = randomUUID()
  const name = opts.name ?? `test-feedback-lane-${randomUUID().slice(0, 8)}`
  await sql`
    INSERT INTO swimlanes (id, project_id, name, is_default, position, org_id)
    VALUES (${id}, ${opts.project_id}, ${name}, false, ${opts.position ?? 999}, ${opts.org_id})
  `
  return { id, name }
}

// Seed a card in the given project/swimlane/column. Returns the new card id.
export async function createTestCard(
  sql: ReturnType<typeof postgres>,
  opts: {
    org_id: string
    project_id: string
    swimlane_id: string
    column_id: string
    title?: string
    post_type?: 'task' | 'feature' | 'bug' | 'artifact' | 'feedback'
    post_meta?: Record<string, any>
  }
): Promise<{ id: string, title: string }> {
  const id = randomUUID()
  const title = opts.title ?? `test-feedback-card-${randomUUID().slice(0, 8)}`
  const postType = opts.post_type ?? 'task'
  const postMeta = opts.post_meta ?? {}
  await sql`
    INSERT INTO cards (id, project_id, swimlane_id, column_id, title, post_type, post_meta, org_id)
    VALUES (${id}, ${opts.project_id}, ${opts.swimlane_id}, ${opts.column_id}, ${title}, ${postType}, ${sql.json(postMeta)}, ${opts.org_id})
  `
  return { id, title }
}

// Look up a global column by its canonical name. Columns are seeded by the
// `feedback_002_create_columns` migration so the lookup is deterministic.
export async function getColumnByName(
  sql: ReturnType<typeof postgres>,
  name: string
): Promise<{ id: string, name: string, position: number }> {
  const rows = await sql<{ id: string, name: string, position: number }[]>`
    SELECT id, name, position FROM columns WHERE name = ${name}
  `
  if (rows.length === 0) throw new Error(`column "${name}" not found (migrations may not have run)`)
  return rows[0]!
}

// --- MCP over the real /mcp transport ---

export interface McpToolResult {
  content: Array<{ type: string, text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

// Mint an oauth client + token family + access token with the same row shapes
// the token endpoint writes. The token's resource must equal the server's
// mcpResource, read from its RFC 9728 metadata so the test doesn't depend on
// the configured site URL. The client id is `test-feedback-` prefixed so
// cleanup can scope its delete.
export async function issueMcpBearer(
  sql: ReturnType<typeof postgres>,
  userId: string,
  scopes: string[]
): Promise<string> {
  const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
  const meta = await metaRes.json() as { resource: string }
  const clientId = `test-feedback-${randomBytes(8).toString('hex')}`
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
    VALUES (${clientId}, 'test-feedback mcp client', ${['http://localhost/callback']})
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

// Wipe every feedback_* / projects / swimlanes / cards / card_column_history /
// feedback_attachments row owned by data this layer's tests created. Anything
// linked to a user whose email is `test-%@example.com` is fair game — the
// per-layer prefixes keep other layers' data safe.
//
// We delete tenant-scoped rows first (children → parents), then let the orgs
// cascade catch any stragglers when tenancy's cleanup runs.
export async function cleanupFeedbackTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  // Wipe via orgs first — every feedback table has org_id ON DELETE CASCADE
  // (from feedback_T010_enable_tenancy.ts), so this wipes the lot in one shot.
  // BUT the orgs we want to nuke aren't deleted yet — only the rows whose
  // org belongs to a feedback-prefixed slug. We could also delete by org_id
  // via subquery, which is what we'll do below for robustness against
  // cross-prefix users (feedback test that created a tenancy-prefixed org).
  await sql`
    DELETE FROM feedback_attachments
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-feedback-%' OR slug LIKE 'test-tenancy-%')
  `
  await sql`
    DELETE FROM card_column_history
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-feedback-%' OR slug LIKE 'test-tenancy-%')
  `
  await sql`
    DELETE FROM cards
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-feedback-%' OR slug LIKE 'test-tenancy-%')
  `
  await sql`
    DELETE FROM swimlanes
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-feedback-%' OR slug LIKE 'test-tenancy-%')
  `
  await sql`
    DELETE FROM projects
    WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-feedback-%' OR slug LIKE 'test-tenancy-%')
  `

  // Activity log rows pointing at the now-orphaned users (logCreate /
  // logUpdate / logDelete fired by feedback handlers). Keyed on the user
  // prefix so cross-layer rows are left alone.
  await sql`
    DELETE FROM activity_logs
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-feedback-%@example.com')
  `

  // Widget rate-limit counters live in activity_logs keyed by IP, with a NULL
  // user_id for anonymous submissions — so the user-scoped delete above misses
  // them and they bleed across tests, tripping the per-IP limit. Clear them.
  await sql`DELETE FROM activity_logs WHERE event_type LIKE 'ratelimit.feedback%'`

  // Now the orgs + users themselves. Tenancy CASCADE handles memberships,
  // org_apps, etc.; users cascade catches activity_logs that we didn't
  // explicitly wipe.
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-feedback-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-feedback-%@example.com'`

  // OAuth clients minted by `issueMcpBearer`. Their token families and access
  // tokens cascade off the user rows deleted just above, so the client rows
  // are unreferenced by the time this runs.
  await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-feedback-%'`
}
