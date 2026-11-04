// Messages-layer test helpers. Re-exports tenancy + core helpers, adds
// helpers for seeding messages_* rows and cleaning up.
//
// All seeded data is prefixed `test-messages-` (users, channel names) so
// `cleanupMessagesTestData` can scope deletes by ownership of the rows.
// Cleanup order is important: messages tables CASCADE off users (author_id
// uses ON DELETE RESTRICT, so we must wipe messages rows first) and off
// orgs (ON DELETE CASCADE). We delete messages content explicitly to also
// catch rows authored by tenancy/core users that happened to land here.
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

// Users / orgs are tagged with `test-messages-` so per-layer cleanup stays
// scoped. Anything tagged `test-tenancy-` or `test-core-` is owned by other
// layers and left alone here.
export async function createMessagesUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-messages-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createMessagesOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-messages-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? `Test Messages Org`
  })
}

// Build a complete org with a user that has the given roles. Default role is
// `admin` so the user gets every registered permission via the admin
// special-case in rbac.ts.
export async function createMessagesOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createMessagesUser(sql)
  const org = await createMessagesOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

// Add another user to an existing org, returning the user + auth bundle.
export async function addMessagesMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createMessagesUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

// Seed a channel directly via the host-admin pool (BYPASSRLS), bypassing the
// `withOrgPermission` route. Tests that exercise the GET conversations list
// don't want to also exercise the POST channels route as setup.
//
// Multi-tenant mode requires `org_id` on every messages_* row — supplied
// here so RLS lets the row through when the spawned Nuxt server reads it
// inside a defineTenantHandler txn (which sets the GUC to this org).
export async function createTestChannel(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, created_by: string, name?: string, description?: string | null }
): Promise<{ id: string, name: string }> {
  const id = randomUUID()
  const name = opts.name ?? `test-messages-channel-${randomUUID().slice(0, 8)}`
  await sql`
    INSERT INTO messages_conversations
      (id, kind, name, description, created_by, org_id)
    VALUES (${id}, 'channel', ${name}, ${opts.description ?? null}, ${opts.created_by}, ${opts.org_id})
  `
  return { id, name }
}

// Seed a 1:1 DM conversation between two users (both must be org members).
export async function createTestDm(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, created_by: string, other_user_id: string }
): Promise<{ id: string }> {
  const id = randomUUID()
  const [lo, hi] = [opts.created_by, opts.other_user_id].sort() as [string, string]
  await sql`
    INSERT INTO messages_conversations
      (id, kind, name, description, created_by, dm_pair_lo, dm_pair_hi, org_id)
    VALUES (${id}, 'dm', null, null, ${opts.created_by}, ${lo}, ${hi}, ${opts.org_id})
  `
  await sql`
    INSERT INTO messages_conversation_members (conversation_id, user_id, role, org_id)
    VALUES (${id}, ${lo}, 'member', ${opts.org_id}),
           (${id}, ${hi}, 'member', ${opts.org_id})
  `
  return { id }
}

// Seed a markdown item directly. Useful as a fixture for comment / reaction
// tests where the POST items route isn't what's under test.
export async function createTestItem(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, conversation_id: string, author_id: string, body_md?: string }
): Promise<{ id: string }> {
  const id = randomUUID()
  const body = opts.body_md ?? 'hello world'
  await sql`
    INSERT INTO messages_items
      (id, conversation_id, author_id, kind, body_md, org_id)
    VALUES (${id}, ${opts.conversation_id}, ${opts.author_id}, 'markdown', ${body}, ${opts.org_id})
  `
  return { id }
}

// Seed a comment on an item.
export async function createTestComment(
  sql: ReturnType<typeof postgres>,
  opts: { org_id: string, item_id: string, author_id: string, body_md?: string, parent_comment_id?: string | null }
): Promise<{ id: string }> {
  const id = randomUUID()
  const body = opts.body_md ?? 'a comment'
  await sql`
    INSERT INTO messages_comments
      (id, item_id, author_id, parent_comment_id, body_md, org_id)
    VALUES (${id}, ${opts.item_id}, ${opts.author_id}, ${opts.parent_comment_id ?? null}, ${body}, ${opts.org_id})
  `
  return { id }
}

// Wipe every messages_* row owned by data this layer's tests created. The
// strategy: messages content lives behind orgs (ON DELETE CASCADE) and users
// (ON DELETE RESTRICT for author_id). We DELETE messages_* first (so the
// users CASCADE doesn't trip on RESTRICT) then let tenancy/core cleanup
// remove the parent orgs + users on their own helpers.
//
// We over-delete intentionally: any messages_* row whose author is a
// test-messages-/test-tenancy-/test-core- user is fair game. This catches
// rows seeded by tests that created cross-prefix users (a tenancy admin
// posting an item, for example).
export async function cleanupMessagesTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  // Children first (no FK reorder required since we're using BYPASSRLS).
  // Order is chosen so that delete-cascades from parent tables don't surprise
  // an INSERT that runs immediately after the cleanup.
  await sql`
    DELETE FROM notifications
    WHERE app_id = 'messages'
      AND (user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
        OR actor_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com'))
  `
  await sql`
    DELETE FROM messages_mentions
    WHERE mentioned_user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_reactions
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_item_stars
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_item_tags
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_user_tags
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_comments
    WHERE author_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_items
    WHERE author_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_channel_subscriptions
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_conversation_reads
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_conversation_members
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `
  await sql`
    DELETE FROM messages_conversations
    WHERE created_by IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
  `

  // Tenancy + core cleanup wipes orgs (cascade) and users (RESTRICT-safe
  // now that messages_* are gone). Run them here so each test file only
  // needs `cleanupMessagesTestData` in `afterEach`.
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-messages-%' OR slug LIKE 'test-tenancy-%'`
  await sql`DELETE FROM activity_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')`
  await sql`DELETE FROM users WHERE email LIKE 'test-messages-%@example.com'`
}
