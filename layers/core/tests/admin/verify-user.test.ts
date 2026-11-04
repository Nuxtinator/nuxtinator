import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createOperatorAdmin,
  createTestUser
} from '../helpers'

describe('POST /api/admin/users/:id/verify', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('verifies a self-registered user who has already set a password', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const user = await createTestUser(sql, { verified: false })

    const res = await $fetch(`/api/admin/users/${user.id}/verify`, { method: 'POST', ...auth })
    expect(res.user.verified).toBe(true)

    const rows = await sql<{ verified: boolean }[]>`SELECT verified FROM users WHERE id = ${user.id}`
    expect(rows[0]!.verified).toBe(true)
  })
})
