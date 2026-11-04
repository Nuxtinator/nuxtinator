// List-of-100-layer test helpers. Re-exports tenancy + core helpers and adds
// list-of-100-specific seeders + a cleanup that wipes rows owned by users
// tagged with the layer's `test-list-of-100-` prefix.
//
// Cleanup contract: only deletes contacts owned by `test-list-of-100-…`,
// `test-tenancy-…`, or `test-core-…` users, then deletes the layer's
// prefixed users and orgs. The tenancy + core cleanups handle their own
// prefix scopes separately.
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

// All seeded users / orgs are tagged with `test-list-of-100-` so per-layer
// cleanup can be aggressive without trampling sibling-layer fixtures.
//
// List of 100 is a personal app that is invite-only by default, so seeded
// users get a `user_apps` grant unless `grant: false`.
export async function createListOf100User(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] & { grant?: boolean } = {}
): Promise<TestUser> {
  const { grant = true, ...userOpts } = opts
  const user = await createTestUser(sql, {
    ...userOpts,
    email: userOpts.email ?? `test-list-of-100-${randomUUID().slice(0, 8)}@example.com`
  })
  if (grant) await grantListOf100(sql, user.id)
  return user
}

export async function grantListOf100(sql: ReturnType<typeof postgres>, userId: string): Promise<void> {
  await sql`INSERT INTO apps (id) VALUES ('list-of-100') ON CONFLICT (id) DO NOTHING`
  await sql`
    INSERT INTO user_apps (user_id, app_id) VALUES (${userId}, 'list-of-100')
    ON CONFLICT (user_id, app_id) DO NOTHING
  `
}

export async function createListOf100Org(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-list-of-100-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? `Test List Of 100 Org`
  })
}

// Build a complete org with a user that has the given roles. Default role is
// `admin` so the user gets every registered permission via the admin
// special-case in rbac.ts.
export async function createListOf100OrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createListOf100User(sql)
  const org = await createListOf100Org(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

// Add another user to an existing org, returning the user + auth bundle.
export async function addListOf100Member(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createListOf100User(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

export interface SeededContact {
  id: string
  user_id: string
  name: string
  relationship: string
  faith_status: string
}

// Seed a contact row directly via host_admin (BYPASSRLS). Useful when the test
// under test is the GET/PATCH/DELETE flow and the POST route isn't what's
// exercised.
export async function createTestContact(
  sql: ReturnType<typeof postgres>,
  opts: {
    user_id: string
    name?: string
    relationship?: 'family' | 'friend' | 'coworker' | 'neighbor' | 'classmate' | 'other'
    faith_status?: 'believer' | 'non_believer' | 'unknown'
    notes?: string | null
    last_contacted_at?: Date | null
    last_prayed_at?: Date | null
    sort_order?: number
  }
): Promise<SeededContact> {
  const id = randomUUID()
  const name = opts.name ?? `test-list-of-100-contact-${randomUUID().slice(0, 6)}`
  const relationship = opts.relationship ?? 'friend'
  const faith_status = opts.faith_status ?? 'unknown'
  const notes = opts.notes ?? null
  const last_contacted_at = opts.last_contacted_at ?? null
  const last_prayed_at = opts.last_prayed_at ?? null
  const sort_order = opts.sort_order ?? 0

  await sql`
    INSERT INTO list_of_100_contacts
      (id, user_id, name, relationship, faith_status, notes, last_contacted_at, last_prayed_at, sort_order)
    VALUES (
      ${id}, ${opts.user_id}, ${name}, ${relationship}, ${faith_status},
      ${notes}, ${last_contacted_at}, ${last_prayed_at}, ${sort_order}
    )
  `
  return { id, user_id: opts.user_id, name, relationship, faith_status }
}

// Seed an activity_logs row (MARK_CONTACTED / MARK_PRAYED) directly. The
// insights and history endpoints read from activity_logs; tests that exercise
// those endpoints don't want to round-trip through the mark-* POSTs as setup.
export async function createTestRhythmEvent(
  sql: ReturnType<typeof postgres>,
  opts: {
    user_id: string
    record_id: string
    event_type: 'MARK_CONTACTED' | 'MARK_PRAYED'
    timestamp?: Date
    metadata?: Record<string, unknown>
  }
): Promise<{ id: string }> {
  const id = randomUUID()
  const timestamp = opts.timestamp ?? new Date()
  const metadata = opts.metadata ?? {}
  await sql`
    INSERT INTO activity_logs
      (id, timestamp, event_type, table_name, record_id, user_id, metadata)
    VALUES (
      ${id}, ${timestamp}, ${opts.event_type}, 'list_of_100_contacts',
      ${opts.record_id}, ${opts.user_id}, ${sql.json(metadata as Record<string, unknown>)}
    )
  `
  return { id }
}

// Wipe rows owned by this layer's test users only (`test-list-of-100-…`).
// Cross-layer cleanups (`cleanupTenancyTestData`, `cleanupCoreTestData`) run
// in parallel from sibling layer projects; we MUST stay inside our own
// prefix or we'll wipe their in-flight fixtures.
export async function cleanupListOf100TestData(sql: ReturnType<typeof postgres>): Promise<void> {
  // Contacts owned by this layer's users (cascades via org_id won't catch
  // these on their own because we delete orgs too — keeping the explicit
  // delete is defensive).
  await sql`
    DELETE FROM list_of_100_contacts
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-list-of-100-%@example.com')
  `

  // Activity logs for this app's table, scoped to this layer's users. The
  // table_name filter is the safety net: even if a user row leaks, we won't
  // touch other tables' audit rows.
  await sql`
    DELETE FROM activity_logs
    WHERE table_name = 'list_of_100_contacts'
      AND user_id IN (SELECT id FROM users WHERE email LIKE 'test-list-of-100-%@example.com')
  `

  // Custom roles seeded under list-of-100 prefix (used to exercise the
  // perm-denied path). Per-org name uniqueness in multi-tenant mode means we
  // can't accidentally wipe other layers' rows.
  await sql`DELETE FROM custom_roles WHERE name LIKE 'test-list-of-100-%'`

  // Drop layer-prefixed orgs (cascades wipe memberships, org_apps, role
  // overrides) and users (cascades wipe their `user_apps` grants).
  await sql`DELETE FROM invites WHERE email LIKE 'test-list-of-100-%@example.com'`
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-list-of-100-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-list-of-100-%@example.com'`
}
