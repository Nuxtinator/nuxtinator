// Videos-layer test helpers. Re-exports tenancy + core helpers, adds
// helpers for seeding `videos` rows and cleaning them up.
//
// All seeded data is prefixed `test-videos-` (users, share tokens, titles)
// so `cleanupVideosTestData` can scope deletes by ownership of the rows.
// Cleanup order matters: `videos` cascades off `users` (ON DELETE CASCADE
// on `user_id`) and off `orgs` (ON DELETE CASCADE on `org_id`). We delete
// videos rows explicitly first to be safe against authors who happened to
// land here from other layers' fixtures.
import type postgres from 'postgres'
import { randomUUID, randomBytes } from 'node:crypto'
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

// Users / orgs are tagged `test-videos-` so per-layer cleanup stays scoped.
// Anything tagged `test-tenancy-` or `test-core-` is owned by other layers
// and left alone here.
export async function createVideosUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-videos-${randomUUID().slice(0, 8)}@example.com`
  })
}

export async function createVideosOrg(
  sql: ReturnType<typeof postgres>,
  opts: { slug?: string, name?: string } = {}
): Promise<TestOrg> {
  return createTestOrg(sql, {
    slug: opts.slug ?? `test-videos-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? `Test Videos Org`
  })
}

// Build a complete org with a user that has the given roles. Default role is
// `admin` so the user gets every registered permission via the admin
// special-case in rbac.ts.
export async function createVideosOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders }> {
  const user = await createVideosUser(sql)
  const org = await createVideosOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })
  return { org, user, auth: getAuthHeaders(user) }
}

// Add another user to an existing org, returning the user + auth bundle.
export async function addVideosMember(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  roles: string[] = ['member']
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createVideosUser(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgId, roles })
  return { user, auth: getAuthHeaders(user) }
}

// Seed a video row directly via the host-admin pool (BYPASSRLS), bypassing
// the `withOrgContext` upload-complete path. Tests that exercise GET / PATCH
// / DELETE / share endpoints don't want to also exercise the upload path as
// setup.
//
// Multi-tenant mode requires `org_id` on every videos row — supplied here so
// RLS lets the row through when the spawned Nuxt server reads it inside a
// `defineTenantHandler` txn (which sets the GUC to this org).
export interface TestVideo {
  id: string
  org_id: string
  user_id: string
  title: string
  share_token: string
  visibility: 'private' | 'org' | 'public'
  s3_key: string
}

export async function createTestVideo(
  sql: ReturnType<typeof postgres>,
  opts: {
    org_id: string
    user_id: string
    title?: string
    visibility?: 'private' | 'org' | 'public'
    duration?: number
    file_size?: number
    width?: number
    height?: number
    view_count?: number
    play_count?: number
  }
): Promise<TestVideo> {
  const id = randomUUID()
  const title = opts.title ?? `test-videos-title-${randomUUID().slice(0, 8)}`
  const visibility = opts.visibility ?? 'private'
  const share_token = `test-videos-${randomBytes(12).toString('hex')}`
  const s3_key = `videos/${id}.webm`
  const duration = opts.duration ?? 30
  const file_size = opts.file_size ?? 1024 * 1024
  const width = opts.width ?? 1280
  const height = opts.height ?? 720
  const view_count = opts.view_count ?? 0
  const play_count = opts.play_count ?? 0

  await sql`
    INSERT INTO videos
      (id, user_id, org_id, title, s3_key, duration, file_size, width, height,
       share_token, visibility, view_count, play_count, source)
    VALUES
      (${id}, ${opts.user_id}, ${opts.org_id}, ${title}, ${s3_key},
       ${duration}, ${file_size}, ${width}, ${height},
       ${share_token}, ${visibility}, ${view_count}, ${play_count}, 'recording')
  `
  return {
    id,
    org_id: opts.org_id,
    user_id: opts.user_id,
    title,
    share_token,
    visibility,
    s3_key
  }
}

// Wipe every videos row authored by data this layer's tests created. Then
// let the tenancy + core cleanup remove the parent orgs + users.
//
// We over-delete intentionally on `email LIKE 'test-%@example.com'`: any
// videos row whose author is a test-videos-/test-tenancy-/test-core- user
// is fair game. This catches rows seeded by cross-prefix fixtures (e.g. a
// tenancy admin uploading a video for cross-layer coverage).
export async function cleanupVideosTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  // Children first. Videos has no children of its own, but `ON DELETE CASCADE`
  // from users + orgs will fire when those parents go — so we wipe explicitly
  // up-front to avoid surprise cascades and to clear share-token-prefixed rows
  // that didn't come with a `test-` user (older fixtures, edge tests).
  await sql`
    DELETE FROM videos
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')
       OR share_token LIKE 'test-videos-%'
  `

  // Orgs cascade-wipe memberships + org_apps + remaining videos. Tenancy
  // cleanup handles its own slug prefix; we add videos- here so each test
  // file only needs `cleanupVideosTestData` in `afterEach`.
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-videos-%' OR slug LIKE 'test-tenancy-%'`
  await sql`DELETE FROM activity_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-%@example.com')`
  await sql`DELETE FROM users WHERE email LIKE 'test-videos-%@example.com'`
}
