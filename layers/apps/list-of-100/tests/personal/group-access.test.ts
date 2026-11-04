// Opening a personal app through a host group, and the admins-only status.
// List of 100 is the personal app under test; it's host_controlled by default.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupListOf100TestData,
  createListOf100User,
  getAuthHeaders
} from '../helpers'

describe('personal app access through host groups', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await sql`DELETE FROM groups WHERE name LIKE 'test-list-of-100-%'`
    await cleanupListOf100TestData(sql)
  })

  async function createGroup(auth: ReturnType<typeof getAuthHeaders>): Promise<string> {
    const { id } = await $fetch<{ id: string }>('/api/admin/groups', {
      method: 'POST', body: { name: `test-list-of-100-${randomUUID().slice(0, 8)}` }, ...auth
    })
    return id
  }

  it('a member of a listed group can open the app until they leave the group', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const user = await createListOf100User(sql, { grant: false })
    const auth = getAuthHeaders(admin)
    const groupId = await createGroup(auth)
    await $fetch(`/api/admin/groups/${groupId}/members/${user.id}`, { method: 'PUT', ...auth })

    const before = await $fetch('/api/list-of-100/contacts', getAuthHeaders(user)).catch(e => e)
    expect(before.statusCode).toBe(410)

    await $fetch('/api/admin/apps/list-of-100/groups', { method: 'PUT', body: { groupIds: [groupId] }, ...auth })
    const listed = await $fetch<{ groups: { id: string, selected: boolean }[] }>('/api/admin/apps/list-of-100/groups', auth)
    expect(listed.groups.find(g => g.id === groupId)?.selected).toBe(true)

    await $fetch('/api/list-of-100/contacts', getAuthHeaders(user))
    const feed = await $fetch<{ apps: { id: string }[] }>('/api/_personal-apps', getAuthHeaders(user))
    expect(feed.apps.map(a => a.id)).toContain('list-of-100')

    const users = await $fetch<{ users: { id: string, granted: boolean, viaGroup: boolean, enabled: boolean }[] }>(
      '/api/admin/apps/list-of-100/users', { query: { q: user.email }, ...auth }
    )
    expect(users.users.find(u => u.id === user.id)).toMatchObject({ granted: false, viaGroup: true, enabled: true })

    await $fetch(`/api/admin/groups/${groupId}/members/${user.id}`, { method: 'DELETE', ...auth })
    const after = await $fetch('/api/list-of-100/contacts', getAuthHeaders(user)).catch(e => e)
    expect(after.statusCode).toBe(410)
  })

  it('refuses to add an archived group to an app\'s list', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const auth = getAuthHeaders(admin)
    const groupId = await createGroup(auth)
    await $fetch(`/api/admin/groups/${groupId}`, { method: 'PATCH', body: { archived: true }, ...auth })

    const err = await $fetch('/api/admin/apps/list-of-100/groups', { method: 'PUT', body: { groupIds: [groupId] }, ...auth }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('\'admins\' opens the app for host admins only, and org apps refuse it', async () => {
    const [before] = await sql<{ status: string | null }[]>`SELECT status FROM apps WHERE id = 'list-of-100'`
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const granted = await createListOf100User(sql)
    const auth = getAuthHeaders(admin)
    try {
      await $fetch('/api/admin/apps/list-of-100', { method: 'PATCH', body: { status: 'admins' }, ...auth })
      await $fetch('/api/list-of-100/contacts', auth)
      const err = await $fetch('/api/list-of-100/contacts', getAuthHeaders(granted)).catch(e => e)
      expect(err.statusCode).toBe(410)

      const orgApp = await $fetch('/api/admin/apps/messages', { method: 'PATCH', body: { status: 'admins' }, ...auth }).catch(e => e)
      expect(orgApp.statusCode).toBe(400)
    } finally {
      await sql`UPDATE apps SET status = ${before?.status ?? null} WHERE id = 'list-of-100'`
    }
  })
})
