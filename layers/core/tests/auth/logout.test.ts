import { describe, it, expect, afterEach } from 'vitest'
import { fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createTestUser,
  createTestSession
} from '../helpers'

describe('POST /api/auth/logout', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('returns success, clears the session cookies and deletes the session', async () => {
    const user = await createTestUser(sql)
    const { sessionId, auth } = await createTestSession(sql, user)

    const res = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: auth.headers
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)

    // Set-Cookie should expire both cookies (Max-Age=0)
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toMatch(/auth-token=;/)
    expect(setCookie).toMatch(/auth-refresh=;/)
    expect(setCookie).toMatch(/Max-Age=0/i)

    const rows = await sql`SELECT 1 FROM sessions WHERE id = ${sessionId}`
    expect(rows.length).toBe(0)
  })

  it('still returns success when called without an auth cookie', async () => {
    const res = await fetch('/api/auth/logout', { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
  })
})
