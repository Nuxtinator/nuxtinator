import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createOperatorAdmin,
  createAndLoginUser,
  createTestUser,
  publicStorageConfigured
} from '../helpers'

// 1x1 PNG.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000d49444154789c63f8cf000000010100000118c4f3a90000000049454e44ae426082',
  'hex'
)
const PHOTO = 'https://example.com/photo.png'

describe('/api/admin/users/:id/avatar', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  async function avatarOf(id: string): Promise<string> {
    return (await sql<{ avatar: string }[]>`SELECT avatar FROM users WHERE id = ${id}`)[0]!.avatar
  }

  async function userWithAvatar() {
    const user = await createTestUser(sql)
    await sql`UPDATE users SET avatar = ${PHOTO} WHERE id = ${user.id}`
    return user
  }

  it('operator admin can remove a user\'s avatar', async () => {
    const { user: admin, auth } = await createOperatorAdmin(sql)
    const user = await userWithAvatar()

    const res = await $fetch(`/api/admin/users/${user.id}/avatar`, { method: 'DELETE', ...auth })
    expect(res.avatar).toBeNull()
    expect(await avatarOf(user.id)).toBe('')

    const [log] = await sql`SELECT user_id FROM activity_logs WHERE event_type = 'admin_user_avatar_removed' AND record_id = ${user.id}`
    expect(log).toMatchObject({ user_id: admin.id })
  })

  it('a user who is not an operator admin cannot change another user\'s avatar', async () => {
    const { auth } = await createAndLoginUser(sql)
    const user = await userWithAvatar()

    const removed = await $fetch(`/api/admin/users/${user.id}/avatar`, { method: 'DELETE', ...auth }).catch(e => e)
    expect(removed.statusCode).toBe(403)

    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(TINY_PNG)], { type: 'image/png' }), 'a.png')
    const uploaded = await $fetch(`/api/admin/users/${user.id}/avatar`, { method: 'POST', body, ...auth }).catch(e => e)
    expect(uploaded.statusCode).toBe(403)

    expect(await avatarOf(user.id)).toBe(PHOTO)
  })

  it('returns 404 for a user that does not exist', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const id = randomUUID()

    const removed = await $fetch(`/api/admin/users/${id}/avatar`, { method: 'DELETE', ...auth }).catch(e => e)
    expect(removed.statusCode).toBe(404)

    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(TINY_PNG)], { type: 'image/png' }), 'a.png')
    const uploaded = await $fetch(`/api/admin/users/${id}/avatar`, { method: 'POST', body, ...auth }).catch(e => e)
    expect(uploaded.statusCode).toBe(404)
  })

  it('the users list and a rename both return the avatar', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const user = await userWithAvatar()

    const list = await $fetch<{ rows: { id: string, avatar: string }[] }>('/api/admin/users?pageSize=200', auth)
    expect(list.rows.find(r => r.id === user.id)?.avatar).toBe(PHOTO)

    const renamed = await $fetch<{ user: { avatar: string } }>(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: { display_name: 'Renamed User' },
      ...auth
    })
    expect(renamed.user.avatar).toBe(PHOTO)
  })

  it.skipIf(!publicStorageConfigured())('operator admin can upload a user\'s avatar', async () => {
    const { user: admin, auth } = await createOperatorAdmin(sql)
    const user = await createTestUser(sql)

    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(TINY_PNG)], { type: 'image/png' }), 'a.png')
    const res = await $fetch<{ avatar: string }>(`/api/admin/users/${user.id}/avatar`, { method: 'POST', body, ...auth })
    expect(res.avatar).toMatch(/^https?:\/\//)
    expect(await avatarOf(user.id)).toBe(res.avatar)

    const [log] = await sql`SELECT user_id FROM activity_logs WHERE event_type = 'admin_user_avatar_updated' AND record_id = ${user.id}`
    expect(log).toMatchObject({ user_id: admin.id })

    await $fetch(`/api/admin/users/${user.id}/avatar`, { method: 'DELETE', ...auth })
  })
})
