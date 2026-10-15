import { describe, it, expect, afterEach, afterAll, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  waitForMailTo,
  extractTokenFromBody,
  clearMailhog
} from '../helpers'

// Each call gets its own synthetic IP so the per-IP rate limiter
// (10/15min) doesn't trip across tests. cleanupCoreTestData wipes any
// residual REGISTER_ATTEMPT rows whose ip matches `test-*` between runs.
function testIp(): string {
  return `test-${randomUUID()}`
}

describe('POST /api/auth/register', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await clearMailhog()
  })

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })
  it('keys the rate limit on the proxy-resolved client IP, not a spoofed leftmost entry', async () => {
    const client = testIp()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await $fetch('/api/auth/register', {
        method: 'POST',
        // A client-supplied fake address sits left of what the trusted proxy appended.
        headers: { 'x-forwarded-for': `203.0.113.${i}, ${client}` },
        body: { email: `test-core-${randomUUID().slice(0, 8)}@example.com`, password: 'password123', display_name: 'Rate Test' }
      }).then(() => 200, e => e.statusCode)
      statuses.push(res)
    }
    expect(statuses.slice(0, 10).every(s => s !== 429)).toBe(true)
    expect(statuses[10]).toBe(429)
  })

  it('returns 400 when fields are missing', async () => {
    const err = await $fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'x-forwarded-for': testIp() },
      body: { email: `test-core-${randomUUID().slice(0, 8)}@example.com` }
    }).catch(e => e)

    expect(err.statusCode).toBe(400)
  })

  it('creates an unverified user, sends verification email, and the token verifies', async () => {
    // Pre-condition: there must be an existing user so the new one is NOT
    // first-user (first-user gets auto-verified + auto-logged-in, which is a
    // separate code path).
    await sql`
      INSERT INTO users (id, email, password, display_name, verified, is_admin, token_key)
      VALUES (${randomUUID()}, ${'test-core-seed-' + randomUUID().slice(0, 8) + '@example.com'},
              'x', 'Seed', true, true, ${randomUUID()})
    `

    const email = `test-core-reg-${randomUUID().slice(0, 8)}@example.com`
    const res = await $fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'x-forwarded-for': testIp() },
      body: { email, password: 'testpassword123', display_name: 'Reg User' }
    })

    expect(res.success).toBe(true)
    expect(res.requiresVerification).toBe(true)
    expect(res.autoLoggedIn).toBe(false)

    const rows = await sql<{ verified: boolean, token_key: string }[]>`
      SELECT verified, token_key FROM users WHERE email = ${email}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.verified).toBe(false)

    const msg = await waitForMailTo(email)
    const token = extractTokenFromBody(msg.body, 'token')
    expect(token).toBe(rows[0]!.token_key)

    await $fetch(`/api/auth/verify?token=${token}`).catch(e => e)
    const after = await sql<{ verified: boolean }[]>`SELECT verified FROM users WHERE email = ${email}`
    expect(after[0]!.verified).toBe(true)
  })

  it('returns 409 on duplicate email', async () => {
    const email = `test-core-dup-${randomUUID().slice(0, 8)}@example.com`
    await $fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'x-forwarded-for': testIp() },
      body: { email, password: 'testpassword123', display_name: 'First' }
    })

    const err = await $fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'x-forwarded-for': testIp() },
      body: { email, password: 'testpassword123', display_name: 'Second' }
    }).catch(e => e)

    expect(err.statusCode).toBe(409)
  })
})
