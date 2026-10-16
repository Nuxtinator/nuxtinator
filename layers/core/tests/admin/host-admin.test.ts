import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createOperatorAdmin,
  createAndLoginUser,
  createTestUser
} from '../helpers'

describe('PUT /api/admin/users/:id/host-admin', () => {
  const sql = getHostAdminDb()

  async function isAdmin(id: string) {
    const rows = await sql<{ is_admin: boolean }[]>`SELECT is_admin FROM users WHERE id = ${id}`
    return rows[0]!.is_admin
  }

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('grants and revokes host admin', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const user = await createTestUser(sql)

    await $fetch(`/api/admin/users/${user.id}/host-admin`, { method: 'PUT', body: { is_admin: true }, ...auth })
    expect(await isAdmin(user.id)).toBe(true)

    await $fetch(`/api/admin/users/${user.id}/host-admin`, { method: 'PUT', body: { is_admin: false }, ...auth })
    expect(await isAdmin(user.id)).toBe(false)
  })

  it('refuses to promote an unverified user', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const user = await createTestUser(sql, { verified: false })

    await expect($fetch(`/api/admin/users/${user.id}/host-admin`, { method: 'PUT', body: { is_admin: true }, ...auth }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(await isAdmin(user.id)).toBe(false)
  })

  it('refuses to revoke your own host admin', async () => {
    const { user, auth } = await createOperatorAdmin(sql)

    await expect($fetch(`/api/admin/users/${user.id}/host-admin`, { method: 'PUT', body: { is_admin: false }, ...auth }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(await isAdmin(user.id)).toBe(true)
  })

  it('rejects non-admins', async () => {
    const { user, auth } = await createAndLoginUser(sql)

    await expect($fetch(`/api/admin/users/${user.id}/host-admin`, { method: 'PUT', body: { is_admin: true }, ...auth }))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(await isAdmin(user.id)).toBe(false)
  })
})
