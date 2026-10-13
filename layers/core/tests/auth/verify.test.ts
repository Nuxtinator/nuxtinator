// Standalone tests for GET /api/auth/verify. The register flow exercises the
// happy path; this file covers the redirect-based responses for the various
// error conditions (already-verified, invalid token, expired).
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createTestUser
} from '../helpers'

// `redirect: 'manual'` so we can assert on the Location header rather than
// following into a 200 HTML page.
async function verifyRaw(token: string) {
  return await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
}

describe('GET /api/auth/verify', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })
  it('returns 400 when token is missing', async () => {
    const res = await fetch('/api/auth/verify', { redirect: 'manual' })
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown token', async () => {
    const res = await verifyRaw(randomUUID())
    expect(res.status).toBe(404)
  })

  it('redirects with verified=already when user is already verified', async () => {
    const user = await createTestUser(sql, { verified: true })
    const tokenRows = await sql<{ token_key: string }[]>`SELECT token_key FROM users WHERE id = ${user.id}`
    const res = await verifyRaw(tokenRows[0]!.token_key)
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(res.headers.get('location')).toMatch(/verified=already/)
  })

  it('redirects with verified=expired when token_expires_at has passed', async () => {
    const user = await createTestUser(sql, { verified: false })
    const past = new Date(Date.now() - 1000).toISOString()
    await sql`UPDATE users SET token_expires_at = ${past} WHERE id = ${user.id}`
    const tokenRows = await sql<{ token_key: string }[]>`SELECT token_key FROM users WHERE id = ${user.id}`

    const res = await verifyRaw(tokenRows[0]!.token_key)
    expect(res.headers.get('location')).toMatch(/verified=expired/)

    // User stays unverified
    const after = await sql<{ verified: boolean }[]>`SELECT verified FROM users WHERE id = ${user.id}`
    expect(after[0]!.verified).toBe(false)
  })

  it('flips verified=true and clears token_expires_at on successful verify', async () => {
    const user = await createTestUser(sql, { verified: false })
    const future = new Date(Date.now() + 60_000).toISOString()
    await sql`UPDATE users SET token_expires_at = ${future} WHERE id = ${user.id}`
    const tokenRows = await sql<{ token_key: string }[]>`SELECT token_key FROM users WHERE id = ${user.id}`

    const res = await verifyRaw(tokenRows[0]!.token_key)
    expect(res.headers.get('location')).toMatch(/verified=success/)

    const after = await sql<{ verified: boolean, token_expires_at: Date | null }[]>`
      SELECT verified, token_expires_at FROM users WHERE id = ${user.id}
    `
    expect(after[0]!.verified).toBe(true)
    expect(after[0]!.token_expires_at).toBeNull()
  })
})
