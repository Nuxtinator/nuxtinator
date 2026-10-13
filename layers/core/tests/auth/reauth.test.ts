import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import bcrypt from 'bcrypt'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createTestUser,
  createTestSession
} from '../helpers'

const TEN_MINUTES = 10 * 60 * 1000

describe('step-up re-authentication', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('asks for re-authentication when a sensitive action has no password and the sign-in is stale', async () => {
    const user = await createTestUser(sql)
    const { auth } = await createTestSession(sql, user, { authenticatedAgoMs: TEN_MINUTES })

    const err = await $fetch('/api/profile/account', { method: 'DELETE', body: {}, ...auth }).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(err.data?.data?.reauth).toBe(true)
  })

  it('POST /api/auth/reauth with the password unlocks sensitive actions', async () => {
    const user = await createTestUser(sql, { password: 'secretpw1' })
    const { auth } = await createTestSession(sql, user, { authenticatedAgoMs: TEN_MINUTES })

    const bad = await $fetch('/api/auth/reauth', { method: 'POST', body: { password: 'nope' }, ...auth }).catch(e => e)
    expect(bad.statusCode).toBe(401)

    await $fetch('/api/auth/reauth', { method: 'POST', body: { password: 'secretpw1' }, ...auth })
    const res = await $fetch('/api/profile/account', { method: 'DELETE', body: {}, ...auth })
    expect(res.success).toBe(true)
    const rows = await sql`SELECT 1 FROM users WHERE id = ${user.id}`
    expect(rows.length).toBe(0)
  })

  it('an account without a password can set one after a recent sign-in', async () => {
    const user = await createTestUser(sql)
    await sql`UPDATE users SET password = NULL WHERE id = ${user.id}`

    const stale = await createTestSession(sql, user, { authenticatedAgoMs: TEN_MINUTES })
    const err = await $fetch('/api/profile/password', { method: 'PATCH', body: { new_password: 'brandnewpw' }, ...stale.auth }).catch(e => e)
    expect(err.statusCode).toBe(403)

    const fresh = await createTestSession(sql, user)
    await $fetch('/api/profile/password', { method: 'PATCH', body: { new_password: 'brandnewpw' }, ...fresh.auth })
    const rows = await sql<{ password: string }[]>`SELECT password FROM users WHERE id = ${user.id}`
    expect(await bcrypt.compare('brandnewpw', rows[0]!.password)).toBe(true)

    // Setting a password signs out the other devices.
    const sessions = await sql<{ id: string }[]>`SELECT id FROM sessions WHERE user_id = ${user.id}`
    expect(sessions.map(s => s.id)).toEqual([fresh.sessionId])
  })

  it('lists sign-in methods', async () => {
    const user = await createTestUser(sql)
    const { auth } = await createTestSession(sql, user)
    const res = await $fetch<{ password: boolean, count: number }>('/api/auth/methods', auth)
    expect(res.password).toBe(true)
    expect(res.count).toBeGreaterThanOrEqual(1)
  })
})
