import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createAndLoginUser,
  createOperatorAdmin,
  createTestUser
} from '../helpers'

const groupName = () => `test-core-${randomUUID().slice(0, 8)}`

interface AdminGroup { id: string, name: string, archived_at: string | null, member_count: number }

describe('/api/admin/groups', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await sql`DELETE FROM core_host_settings WHERE namespace = 'core' AND key = 'group_mode'`
    await cleanupCoreTestData(sql)
  })

  it('is operator-admin only', async () => {
    const { auth } = await createAndLoginUser(sql)
    expect((await $fetch('/api/admin/groups', auth).catch(e => e)).statusCode).toBe(403)
    const post = await $fetch('/api/admin/groups', { method: 'POST', body: { name: groupName() }, ...auth }).catch(e => e)
    expect(post.statusCode).toBe(403)
  })

  it('creates, renames, archives and deletes a host group', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const name = groupName()
    const { id } = await $fetch<{ id: string }>('/api/admin/groups', { method: 'POST', body: { name }, ...auth })

    const dup = await $fetch('/api/admin/groups', { method: 'POST', body: { name: name.toUpperCase() }, ...auth }).catch(e => e)
    expect(dup.statusCode).toBe(409)

    const renamed = groupName()
    await $fetch(`/api/admin/groups/${id}`, { method: 'PATCH', body: { name: renamed, archived: true }, ...auth })
    const list = await $fetch<{ mode: string, groups: AdminGroup[] }>('/api/admin/groups', auth)
    expect(list.mode).toBe('audiences')
    const row = list.groups.find(g => g.id === id)!
    expect(row.name).toBe(renamed)
    expect(row.archived_at).not.toBeNull()

    await $fetch(`/api/admin/groups/${id}`, { method: 'DELETE', ...auth })
    expect(await sql`SELECT 1 FROM groups WHERE id = ${id}`).toHaveLength(0)
  })

  it('adds and removes members, and deleting the group drops its app access', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const member = await createTestUser(sql)
    const { id } = await $fetch<{ id: string }>('/api/admin/groups', { method: 'POST', body: { name: groupName() }, ...auth })

    await $fetch(`/api/admin/groups/${id}/members/${member.id}`, { method: 'PUT', ...auth })
    await $fetch(`/api/admin/groups/${id}/members/${member.id}`, { method: 'PUT', ...auth })
    const { members } = await $fetch<{ members: { user_id: string }[] }>(`/api/admin/groups/${id}/members`, auth)
    expect(members.map(m => m.user_id)).toEqual([member.id])

    const missing = await $fetch(`/api/admin/groups/${id}/members/${randomUUID()}`, { method: 'PUT', ...auth }).catch(e => e)
    expect(missing.statusCode).toBe(404)

    await sql`INSERT INTO apps (id) VALUES ('test-core-app') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_groups (app_id, group_id) VALUES ('test-core-app', ${id})`
    try {
      await $fetch(`/api/admin/groups/${id}/members/${member.id}`, { method: 'DELETE', ...auth })
      expect(await sql`SELECT 1 FROM group_members WHERE group_id = ${id}`).toHaveLength(0)

      await $fetch(`/api/admin/groups/${id}`, { method: 'DELETE', ...auth })
      expect(await sql`SELECT 1 FROM app_groups WHERE group_id = ${id}`).toHaveLength(0)
    } finally {
      await sql`DELETE FROM apps WHERE id = 'test-core-app'`
    }
  })

  it('404s for an unknown group id', async () => {
    const { auth } = await createOperatorAdmin(sql)
    expect((await $fetch(`/api/admin/groups/${randomUUID()}/members`, auth).catch(e => e)).statusCode).toBe(404)
    expect((await $fetch('/api/admin/groups/not-a-uuid', { method: 'DELETE', ...auth }).catch(e => e)).statusCode).toBe(404)
  })

  it('sets the group mode, and choosing the default drops the override', async () => {
    const { auth } = await createOperatorAdmin(sql)
    expect(await $fetch('/api/admin/settings', auth)).toMatchObject({ groupMode: 'audiences', labels: { groupMode: 'Group mode' } })

    await $fetch('/api/admin/settings', { method: 'PUT', body: { groupMode: 'teams' }, ...auth })
    expect(await $fetch('/api/admin/settings', auth)).toMatchObject({ groupMode: 'teams', selfRegistration: true })

    await $fetch('/api/admin/settings', { method: 'PUT', body: { groupMode: 'audiences' }, ...auth })
    expect(await sql`SELECT 1 FROM core_host_settings WHERE namespace = 'core' AND key = 'group_mode'`).toHaveLength(0)

    const bad = await $fetch('/api/admin/settings', { method: 'PUT', body: { groupMode: 'clans' }, ...auth }).catch(e => e)
    expect(bad.statusCode).toBe(400)
  })
})

describe('/api/groups', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await sql`DELETE FROM core_host_settings WHERE namespace = 'core' AND key = 'group_mode'`
    await cleanupCoreTestData(sql)
  })

  it('lists the caller\'s groups, with members only in teams mode', async () => {
    const { auth: adminAuth } = await createOperatorAdmin(sql)
    const { user, auth } = await createAndLoginUser(sql)
    const other = await createTestUser(sql)
    const name = groupName()
    const { id } = await $fetch<{ id: string }>('/api/admin/groups', { method: 'POST', body: { name }, ...adminAuth })
    await $fetch(`/api/admin/groups/${id}/members/${user.id}`, { method: 'PUT', ...adminAuth })
    await $fetch(`/api/admin/groups/${id}/members/${other.id}`, { method: 'PUT', ...adminAuth })

    const audiences = await $fetch<{ mode: string, groups: { id: string, name: string, members?: unknown[] }[] }>('/api/groups', auth)
    expect(audiences.mode).toBe('audiences')
    expect(audiences.groups).toEqual([{ id, name, archived: false }])

    await $fetch('/api/admin/settings', { method: 'PUT', body: { groupMode: 'teams' }, ...adminAuth })
    const teams = await $fetch<{ groups: { id: string, members: { id: string }[] }[] }>('/api/groups', auth)
    expect(teams.groups[0]!.members.map(m => m.id).sort()).toEqual([user.id, other.id].sort())
  })
})
