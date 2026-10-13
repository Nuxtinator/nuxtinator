// JWT + cookie helpers for tests. Mirrors the contract of
// `layers/core/server/utils/auth.ts` — same payload shape, same secret, same
// cookie name.
import type postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

const BCRYPT_ROUNDS = 10

export interface TestUser {
  id: string
  email: string
  display_name: string
  password: string
  verified: boolean
  is_admin: boolean
}

export interface AuthHeaders {
  headers: { cookie: string }
}

function jwtSecret(): string {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET must be set in the test environment (dev/.env)')
  return s
}

// Insert a user directly via SQL. Bypasses /api/auth/register so tests that
// need a logged-in user as setup don't have to round-trip through the email
// verification flow. Email defaults to `test-core-<uuid>@example.com` so the
// cleanup helper can find it.
export async function createTestUser(
  sql: ReturnType<typeof postgres>,
  opts: {
    email?: string
    display_name?: string
    password?: string
    verified?: boolean
    is_admin?: boolean
  } = {}
): Promise<TestUser> {
  const id = randomUUID()
  const email = opts.email ?? `test-core-${randomUUID().slice(0, 8)}@example.com`
  const display_name = opts.display_name ?? 'Test User'
  const password = opts.password ?? 'testpassword123'
  const verified = opts.verified ?? true
  const is_admin = opts.is_admin ?? false
  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const tokenKey = randomUUID()

  await sql`
    INSERT INTO users (id, email, password, display_name, verified, is_admin, token_key)
    VALUES (${id}, ${email}, ${hashed}, ${display_name}, ${verified}, ${is_admin}, ${tokenKey})
  `

  return { id, email, display_name, password, verified, is_admin }
}

// A session access token. The `sid` need not exist in `sessions` — access
// tokens are verified statelessly — but endpoints that act on the session
// (logout, step-up) need a real row; use `createTestSession` for those.
export function generateTestToken(user: TestUser, sessionId: string = randomUUID()): string {
  return jwt.sign(
    { userId: user.id, email: user.email, display_name: user.display_name, sid: sessionId },
    jwtSecret(),
    { expiresIn: '7d' }
  )
}

// Inserts a `sessions` row for the user and returns cookie headers bound to
// it. `authenticatedAgoMs` backdates the last sign-in, e.g. past the step-up
// window.
export async function createTestSession(
  sql: ReturnType<typeof postgres>,
  user: TestUser,
  opts: { authenticatedAgoMs?: number } = {}
): Promise<{ sessionId: string, auth: AuthHeaders }> {
  const sessionId = randomUUID()
  const authenticatedAt = new Date(Date.now() - (opts.authenticatedAgoMs ?? 0)).toISOString()
  const expiresAt = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString()
  await sql`
    INSERT INTO sessions (id, user_id, client, refresh_token_hash, expires_at, authenticated_at)
    VALUES (${sessionId}, ${user.id}, 'web', ${randomUUID()}, ${expiresAt}, ${authenticatedAt})
  `
  return { sessionId, auth: { headers: { cookie: `auth-token=${generateTestToken(user, sessionId)}` } } }
}

// A scope-tagged bearer token, matching `signScopedToken` in core auth. Used
// by cross-origin flows (e.g. the feedback widget's `Authorization: Bearer`),
// which verify the token carries the expected `scope` claim.
export function generateScopedTestToken(user: TestUser, scope: string): string {
  return jwt.sign(
    { userId: user.id, email: user.email, display_name: user.display_name, scope },
    jwtSecret(),
    { expiresIn: '7d' }
  )
}

export function getAuthHeaders(user: TestUser): AuthHeaders {
  const token = generateTestToken(user)
  return { headers: { cookie: `auth-token=${token}` } }
}

export async function createAndLoginUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createTestUser(sql, opts)
  return { user, auth: getAuthHeaders(user) }
}

export async function createOperatorAdmin(
  sql: ReturnType<typeof postgres>,
  opts: Omit<Parameters<typeof createTestUser>[1], 'is_admin'> = {}
): Promise<{ user: TestUser, auth: AuthHeaders }> {
  return createAndLoginUser(sql, { ...opts, is_admin: true })
}
