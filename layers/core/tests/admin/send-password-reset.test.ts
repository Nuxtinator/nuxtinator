import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createOperatorAdmin,
  createTestUser,
  waitForMailTo,
  extractTokenFromBody,
  clearMailhog
} from '../helpers'

describe('POST /api/admin/users/:id/send-password-reset', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await clearMailhog()
  })

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('creates a reset row and emails the user when a password is set', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const user = await createTestUser(sql, { display_name: 'Reset Target' })

    const res = await $fetch(`/api/admin/users/${user.id}/send-password-reset`, { method: 'POST', ...auth })
    expect(res.success).toBe(true)

    const rows = await sql<{ token: string, used: boolean }[]>`
      SELECT token, used FROM password_reset_requests WHERE user_id = ${user.id}`
    expect(rows.length).toBe(1)
    expect(rows[0]!.used).toBe(false)

    const msg = await waitForMailTo(user.email)
    expect(extractTokenFromBody(msg.body, 'token')).toBe(rows[0]!.token)
  })

  it('emails a reset to an account with no password, so it can add one', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const user = await createTestUser(sql, { display_name: 'Provider Only' })
    await sql`UPDATE users SET password = NULL WHERE id = ${user.id}`

    const res = await $fetch(`/api/admin/users/${user.id}/send-password-reset`, { method: 'POST', ...auth })
    expect(res.success).toBe(true)

    const rows = await sql<{ c: number }[]>`SELECT count(*)::int as c FROM password_reset_requests WHERE user_id = ${user.id}`
    expect(rows[0]!.c).toBe(1)
  })
})
