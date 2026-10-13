// Tenancy-layer test helpers: orgs, memberships, the X-Active-Org header.
// Always seed via host_admin (BYPASSRLS); RLS would block plain inserts into
// tenant tables (the GUC isn't set outside of `defineTenantHandler`'s txn).
import type postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { createTestUser, getAuthHeaders, type AuthHeaders, type TestUser } from '@nuxtinator/core/test-helpers'

export interface TestOrg {
  id: string
  slug: string
  name: string
}

export async function createTestOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  const id = randomUUID()
  const slug = opts.slug ?? `test-tenancy-${randomUUID().slice(0, 8)}`
  const name = opts.name ?? `Test Org ${slug}`
  await sql`
    INSERT INTO orgs (id, slug, name)
    VALUES (${id}, ${slug}, ${name})
  `
  // Catalog apps default to off for orgs; tests exercise every app.
  await sql`
    INSERT INTO org_apps (org_id, app_id, enabled, source)
    SELECT ${id}, a.id, true, 'auto' FROM apps a
  `
  return { id, slug, name }
}

export async function addTestMembership(
  sql: ReturnType<typeof postgres>,
  opts: { user_id: string, org_id: string, roles?: string[] }
): Promise<void> {
  const id = randomUUID()
  const roles = opts.roles ?? ['member']
  await sql`
    INSERT INTO memberships (id, user_id, org_id, roles)
    VALUES (${id}, ${opts.user_id}, ${opts.org_id}, ${roles})
  `
}

// Tenancy tests prefix users with `test-tenancy-` (not `test-core-`) so
// per-layer cleanup stays scoped. Layers' cleanup helpers only delete their
// own prefixes; cross-layer collisions are by-design impossible.
export async function createTenancyUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-tenancy-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createOrgWithAdmin(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createTenancyUser(sql)
  const org = await createTestOrg(sql, opts)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })
  return { org, user, auth: getAuthHeaders(user) }
}

// Wrap an AuthHeaders bundle with the X-Active-Org header used by app-layer
// API routes. Tenancy admin routes (/api/admin/orgs/...) use the path param
// instead and ignore this header.
export function withOrgHeader(auth: AuthHeaders, slug: string): { headers: { cookie: string, 'x-active-org': string } } {
  return {
    headers: {
      ...auth.headers,
      'x-active-org': slug
    }
  }
}

// Cleanup: delete tenancy-prefixed orgs (cascades wipe memberships, org_apps,
// org_role_overrides) and tenancy-prefixed users.
export async function cleanupTenancyTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DELETE FROM invites WHERE email LIKE 'test-tenancy-%@example.com' OR display_name LIKE 'test-tenancy-%'`
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-tenancy-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-tenancy-%@example.com'`
}
