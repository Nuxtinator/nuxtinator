import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createTestUser,
  getAuthHeaders
} from '../helpers'

describe('POST /api/auth/login + GET /api/auth/me', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })
  it('returns 401 with invalid credentials', async () => {
    const user = await createTestUser(sql, { password: 'rightpw' })
    const err = await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'wrongpw' }
    }).catch(e => e)

    expect(err.statusCode).toBe(401)
  })

  it('a concurrent burst of wrong passwords gets at most 10 tries per email', async () => {
    const user = await createTestUser(sql, { password: 'rightpw' })
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      $fetch('/api/auth/login', { method: 'POST', body: { email: user.email, password: `wrong-${i}` } }).catch(e => e)
    ))
    const statuses = results.map(r => r.statusCode)
    expect(statuses.filter(s => s === 401).length).toBeLessThanOrEqual(10)
    expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(20)
  })

  it('returns 401 when user is not verified', async () => {
    const user = await createTestUser(sql, { verified: false, password: 'pw' })
    const err = await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'pw' }
    }).catch(e => e)

    expect(err.statusCode).toBe(401)
    expect(String(err.statusMessage)).toMatch(/verify/i)
  })

  it('logs in a verified user and returns user payload + cookie', async () => {
    const user = await createTestUser(sql, { password: 'pw', display_name: 'Login User' })

    // raw fetch (returns a Response) to inspect Set-Cookie. $fetch parses the
    // body but drops the response object, so we use the lower-level helper.
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: 'pw' })
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.user.email).toBe(user.email)
    expect(data.success).toBe(true)

    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toMatch(/auth-token=/)
  })

  it('matches the email case-insensitively', async () => {
    const user = await createTestUser(sql, { email: `test-core-MiXed-${Date.now()}@example.com`, password: 'pw' })
    const res = await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email: user.email.toUpperCase(), password: 'pw' }
    })

    expect(res.user.id).toBe(user.id)
  })

  it('GET /api/auth/me returns 401 without cookie', async () => {
    const err = await $fetch('/api/auth/me').catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('GET /api/auth/me returns the user with a valid cookie', async () => {
    const user = await createTestUser(sql, { display_name: 'Me User' })
    const res = await $fetch('/api/auth/me', getAuthHeaders(user))

    expect(res.user.id).toBe(user.id)
    expect(res.user.email).toBe(user.email)
    expect(res.user.display_name).toBe('Me User')
  })
})
