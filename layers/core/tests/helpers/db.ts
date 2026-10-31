// Test DB connection helpers. Two pools mirroring prod's role split:
//   hostAdminDb  — TEST_DATABASE_URL,     host_admin role (BYPASSRLS)
//   appUserDb    — TEST_APP_DATABASE_URL, app_user role (RLS-enforced)
//
// Tests almost always seed via hostAdminDb (so RLS doesn't block setup) and
// assert the app's behavior via real HTTP through $fetch (which goes through
// the Nuxt server's app_user-roled `db`).
import postgres from 'postgres'
import { createPgPool } from '../../server/utils/db-connection'

let _hostAdmin: ReturnType<typeof postgres> | null = null
let _appUser: ReturnType<typeof postgres> | null = null

function buildPool(url: string): ReturnType<typeof postgres> {
  return createPgPool(url, { max: 5, idle_timeout: 10 })
}

export function getHostAdminDb(): ReturnType<typeof postgres> {
  if (_hostAdmin) return _hostAdmin
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run scripts/setup-test-db.sh and add the printed values to dev/.env.'
    )
  }
  _hostAdmin = buildPool(url)
  return _hostAdmin
}

export function getAppUserDb(): ReturnType<typeof postgres> {
  if (_appUser) return _appUser
  const url = process.env.TEST_APP_DATABASE_URL
  if (!url) {
    throw new Error('TEST_APP_DATABASE_URL is not set. See scripts/setup-test-db.sh output.')
  }
  _appUser = buildPool(url)
  return _appUser
}

export async function closeTestDatabases(): Promise<void> {
  if (_hostAdmin) {
    await _hostAdmin.end()
    _hostAdmin = null
  }
  if (_appUser) {
    await _appUser.end()
    _appUser = null
  }
}

// Per-layer cleanup. Core owns users + activity_logs + password_reset_requests
// + custom_roles. Cascade FKs handle the dependents on `users` (memberships,
// org_apps via orgs, etc) when the tenancy cleanup runs first.
//
// Convention: every core test creates users with `email LIKE 'test-core-%@example.com'`.
// Anything else gets left alone — that's the safety property of name-prefixing.
//
// Rate-limiter activity logs (REGISTER_ATTEMPT keyed by IP, LOGIN_FAILED
// keyed by email) get wiped too — otherwise the per-IP and per-email caps
// would trip across test runs that hammer /register and /login. Every test
// uses an x-forwarded-for of `test-<uuid>` so the IP rows are easy to find.
export async function cleanupCoreTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DELETE FROM activity_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-core-%@example.com' OR email LIKE 'test-tenancy-%@example.com')`
  await sql`DELETE FROM activity_logs WHERE event_type IN ('REGISTER_ATTEMPT', 'LOGIN_FAILED', 'LOGIN_ATTEMPT', 'PASSWORD_RESET_REQUEST', 'RATE_LIMIT_EXCEEDED') AND (metadata->>'ip' LIKE 'test-%' OR metadata->>'email' LIKE 'test-%@example.com')`
  await sql`DELETE FROM password_reset_requests WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-core-%@example.com')`
  await sql`DELETE FROM invites WHERE email LIKE 'test-core-%@example.com' OR (email IS NULL AND display_name LIKE 'test-core-%') OR accepted_by IN (SELECT id FROM users WHERE email LIKE 'test-core-%@example.com')`
  await sql`DELETE FROM groups WHERE name LIKE 'test-core-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-core-%@example.com'`
}
