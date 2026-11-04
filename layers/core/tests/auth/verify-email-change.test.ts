// Email-change verification flow. The endpoint redirects to the account page with a
// query string indicating the outcome.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createTestUser
} from '../helpers'

async function visit(token: string) {
  return await fetch(`/api/auth/verify-email-change?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
}

describe('GET /api/auth/verify-email-change', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })
  it('returns 400 when token is missing', async () => {
    const res = await fetch('/api/auth/verify-email-change', { redirect: 'manual' })
    expect(res.status).toBe(400)
  })

  it('redirects with invalid_token when token is unknown', async () => {
    const res = await visit(randomUUID())
    expect(res.headers.get('location')).toMatch(/invalid_token/)
  })

  it('redirects with no_pending when user has no pending_email', async () => {
    const user = await createTestUser(sql)
    const token = randomUUID()
    await sql`UPDATE users SET email_change_token = ${token} WHERE id = ${user.id}`

    const res = await visit(token)
    expect(res.headers.get('location')).toMatch(/no_pending/)
  })

  it('redirects with email_taken when the new email is now in use by another user', async () => {
    const a = await createTestUser(sql)
    const b = await createTestUser(sql) // collides

    const token = randomUUID()
    await sql`
      UPDATE users
      SET pending_email = ${b.email}, email_change_token = ${token}
      WHERE id = ${a.id}
    `

    const res = await visit(token)
    expect(res.headers.get('location')).toMatch(/email_taken/)

    // Pending fields cleared, original email unchanged
    const rows = await sql<{ email: string, pending_email: string | null, email_change_token: string | null }[]>`
      SELECT email, pending_email, email_change_token FROM users WHERE id = ${a.id}
    `
    expect(rows[0]!.email).toBe(a.email)
    expect(rows[0]!.pending_email).toBeNull()
    expect(rows[0]!.email_change_token).toBeNull()
  })

  it('successful change flips email + clears pending fields', async () => {
    const user = await createTestUser(sql)
    const token = randomUUID()
    const newEmail = `test-core-changed-${randomUUID().slice(0, 8)}@example.com`
    await sql`
      UPDATE users
      SET pending_email = ${newEmail}, email_change_token = ${token}
      WHERE id = ${user.id}
    `

    const res = await visit(token)
    expect(res.headers.get('location')).toBe('/account?email_change=success')

    const rows = await sql<{ email: string, pending_email: string | null, email_change_token: string | null }[]>`
      SELECT email, pending_email, email_change_token FROM users WHERE id = ${user.id}
    `
    expect(rows[0]!.email).toBe(newEmail)
    expect(rows[0]!.pending_email).toBeNull()
    expect(rows[0]!.email_change_token).toBeNull()
  })
})
