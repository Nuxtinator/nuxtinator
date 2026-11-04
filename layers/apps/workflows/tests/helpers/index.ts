// Workflows-layer test helpers. Re-exports tenancy + core helpers and adds
// org/user bootstrap with the `test-workflows-` prefix plus prefix-scoped
// cleanup. workflows_views.owner_id is ON DELETE RESTRICT, so views are
// wiped explicitly before users; shares and card placements cascade off the
// view row.
import type postgres from 'postgres'
import { randomUUID } from 'node:crypto'
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

export async function createWorkflowsUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-workflows-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createWorkflowsOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-workflows-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? 'Test Workflows Org'
  })
}

// Complete org + user with the given roles. Default `admin` gets every
// registered permission via the admin special-case in rbac.ts.
export async function createWorkflowsOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin'],
  userOpts: Parameters<typeof createTestUser>[1] = {}
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createWorkflowsUser(sql, userOpts)
  const org = await createWorkflowsOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

export async function addWorkflowsMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createWorkflowsUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

/**
 * Org-scoped custom role carrying exactly the given permission slugs — the
 * tool for callers that must hold `workflows.use` but no CRM write access.
 */
export async function createWorkflowsRole(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  permissions: string[]
): Promise<string> {
  const name = `test-workflows-role-${randomUUID().slice(0, 8)}`
  await sql`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'scoped perms for tests', ${permissions}::text[], ${orgId})
  `
  return name
}

export async function cleanupWorkflowsTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  // Scoped strictly to this layer's own prefix: projects run in parallel,
  // and a broader 'test-%' sweep here would delete other projects' records
  // out from under their in-flight tests.
  await sql`
    DELETE FROM workflows_views
    WHERE owner_id IN (SELECT id FROM users WHERE email LIKE 'test-workflows-%@example.com')
  `
  await sql`
    DELETE FROM crm_records
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-workflows-%@example.com')
  `
  // Orgs cascade memberships, org_apps, custom roles, and org-scoped rows.
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-workflows-%'`
  await sql`
    DELETE FROM activity_logs
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-workflows-%@example.com')
  `
  await sql`DELETE FROM users WHERE email LIKE 'test-workflows-%@example.com'`
}
