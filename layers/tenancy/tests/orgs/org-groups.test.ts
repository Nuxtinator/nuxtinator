// An org's groups: management from org settings and /admin/orgs, the group
// mode, the caller's teams, leaving the org, and the team gate on org apps.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOrgWithAdmin,
  createTenancyUser,
  addTestMembership,
  withOrgHeader,
  getAuthHeaders
} from '../helpers'

type Auth = ReturnType<typeof withOrgHeader>

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err: unknown) {
    return (err as { statusCode?: number, response?: { status?: number } }).response?.status
      ?? (err as { statusCode?: number }).statusCode ?? 0
  }
}

describe('org groups', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await sql`DELETE FROM groups WHERE name LIKE 'test-tenancy-%'`
    await cleanupTenancyTestData(sql)
  })

  async function setup() {
    const { org, user: admin, auth } = await createOrgWithAdmin(sql)
    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: ['member'] })
    return { org, admin, adminH: withOrgHeader(auth, org.slug), member, memberH: withOrgHeader(getAuthHeaders(member), org.slug) }
  }

  async function createGroup(slug: string, h: Auth, name = `test-tenancy-${Math.random().toString(36).slice(2, 8)}`) {
    return await $fetch<{ id: string }>(`/api/o/${slug}/groups`, { method: 'POST', body: { name }, ...h })
  }

  it('lets an org admin create groups and add members; members can\'t manage them', async () => {
    const { org, adminH, member, memberH } = await setup()
    const group = await createGroup(org.slug, adminH)

    expect(await status($fetch(`/api/o/${org.slug}/groups`, memberH))).toBe(403)

    await $fetch(`/api/o/${org.slug}/groups/${group.id}/members/${member.id}`, { method: 'PUT', ...adminH })
    const { members } = await $fetch<{ members: { user_id: string }[] }>(`/api/o/${org.slug}/groups/${group.id}/members`, adminH)
    expect(members.map(m => m.user_id)).toEqual([member.id])

    const listed = await $fetch<{ mode: string, groups: { id: string, member_count: number }[] }>(`/api/o/${org.slug}/groups`, adminH)
    expect(listed.mode).toBe('teams')
    expect(listed.groups.find(g => g.id === group.id)?.member_count).toBe(1)
  })

  it('lets a role with only org.groups.manage find members to add', async () => {
    const { org, adminH, member } = await setup()
    const role = await $fetch<{ name: string }>(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name: 'Group keeper', permissions: ['org.groups.manage'] },
      ...adminH
    })
    const keeper = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: keeper.id, org_id: org.id, roles: [role.name] })
    const keeperH = withOrgHeader(getAuthHeaders(keeper), org.slug)

    expect(await status($fetch(`/api/o/${org.slug}/members`, keeperH))).toBe(403)
    const { users } = await $fetch<{ users: { id: string }[] }>(`/api/o/${org.slug}/groups/candidates`, { query: { q: '' }, ...keeperH })
    expect(users.map(u => u.id)).toContain(member.id)
  })

  it('refuses to add someone who isn\'t in the org', async () => {
    const { org, adminH } = await setup()
    const group = await createGroup(org.slug, adminH)
    const outsider = await createTenancyUser(sql)
    expect(await status($fetch(`/api/o/${org.slug}/groups/${group.id}/members/${outsider.id}`, { method: 'PUT', ...adminH }))).toBe(404)
  })

  it('keeps one org\'s groups out of another org\'s routes', async () => {
    const a = await setup()
    const b = await setup()
    const group = await createGroup(a.org.slug, a.adminH)
    expect(await status($fetch(`/api/o/${b.org.slug}/groups/${group.id}/members`, b.adminH))).toBe(404)
    expect(await status($fetch(`/api/o/${b.org.slug}/groups/${group.id}`, { method: 'DELETE', ...b.adminH }))).toBe(404)
  })

  it('runs an org\'s groups as teams by default, and lists the caller\'s teams only then', async () => {
    const { org, adminH, member, memberH } = await setup()
    const group = await createGroup(org.slug, adminH)
    await $fetch(`/api/o/${org.slug}/groups/${group.id}/members/${member.id}`, { method: 'PUT', ...adminH })

    const res = await $fetch<{ mode: string, teams: { id: string }[] }>('/api/teams', memberH)
    expect(res.mode).toBe('teams')
    expect(res.teams.map(t => t.id)).toEqual([group.id])

    await $fetch(`/api/o/${org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'audiences' }, ...adminH })
    expect((await $fetch<{ mode: string, teams: unknown[] }>('/api/teams', memberH))).toEqual({ mode: 'audiences', teams: [] })
    const [row] = await sql`SELECT value FROM core_settings WHERE org_id = ${org.id} AND namespace = 'core' AND key = 'org_group_mode'`
    expect(row?.value).toBe('audiences')

    await $fetch(`/api/o/${org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'teams' }, ...adminH })
    expect(await sql`SELECT 1 FROM core_settings WHERE org_id = ${org.id} AND namespace = 'core' AND key = 'org_group_mode'`).toHaveLength(0)
  })

  it('takes someone out of the org\'s groups when they leave the org', async () => {
    const { org, adminH, member } = await setup()
    const group = await createGroup(org.slug, adminH)
    await $fetch(`/api/o/${org.slug}/groups/${group.id}/members/${member.id}`, { method: 'PUT', ...adminH })

    await $fetch(`/api/o/${org.slug}/members/${member.id}`, { method: 'DELETE', ...adminH })
    const rows = await sql`SELECT 1 FROM group_members WHERE group_id = ${group.id}`
    expect(rows.length).toBe(0)
  })

  it('lets a host admin manage an org\'s groups from /admin/orgs', async () => {
    const { org, member } = await setup()
    const host = await createTenancyUser(sql, { is_admin: true })
    const h = getAuthHeaders(host)

    const group = await $fetch<{ id: string }>(`/api/admin/orgs/${org.id}/groups`, { method: 'POST', body: { name: 'test-tenancy-host-made' }, ...h })
    await $fetch(`/api/admin/orgs/${org.id}/groups/${group.id}/members/${member.id}`, { method: 'PUT', ...h })
    await $fetch(`/api/admin/orgs/${org.id}/groups/mode`, { method: 'PUT', body: { mode: 'teams' }, ...h })

    const listed = await $fetch<{ mode: string, groups: { id: string, org_id: string }[] }>(`/api/admin/orgs/${org.id}/groups`, h)
    expect(listed.mode).toBe('teams')
    expect(listed.groups.map(g => g.id)).toEqual([group.id])
  })

  describe('team gate on org apps', () => {
    it('closes a group-limited app to members outside the group, everywhere they could open it', async () => {
      const { org, adminH, member, memberH } = await setup()
      const group = await createGroup(org.slug, adminH)
      await $fetch(`/api/o/${org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [group.id] }, ...adminH })

      expect(await status($fetch('/api/messages/org-users', memberH))).toBe(403)
      const feed = await $fetch<{ apps: { id: string }[] }>(`/api/o/${org.slug}/_apps`, memberH)
      expect(feed.apps.some(a => a.id === 'messages')).toBe(false)
      const access = await $fetch<{ apps: { id: string, permitted: boolean }[] }>(`/api/o/${org.slug}/_app-access`, memberH)
      expect(access.apps.find(a => a.id === 'messages')?.permitted).toBe(false)
      const nav = await $fetch<{ items: unknown[] }>(`/api/o/${org.slug}/_nav?app=messages`, memberH)
      expect(nav.items).toEqual([])

      await $fetch(`/api/o/${org.slug}/groups/${group.id}/members/${member.id}`, { method: 'PUT', ...adminH })
      expect(await status($fetch('/api/messages/org-users', memberH))).toBe(200)
      const after = await $fetch<{ apps: { id: string }[] }>(`/api/o/${org.slug}/_apps`, memberH)
      expect(after.apps.some(a => a.id === 'messages')).toBe(true)
    })

    it('shows the limit on the org apps page and lifts it when no group is picked', async () => {
      const { org, adminH, memberH } = await setup()
      const group = await createGroup(org.slug, adminH, 'test-tenancy-dev')
      await $fetch(`/api/o/${org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [group.id] }, ...adminH })

      const { apps } = await $fetch<{ apps: { appId: string, groups: string[] }[] }>(`/api/o/${org.slug}/apps`, adminH)
      expect(apps.find(a => a.appId === 'messages')?.groups).toEqual(['test-tenancy-dev'])

      await $fetch(`/api/o/${org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [] }, ...adminH })
      expect(await status($fetch('/api/messages/org-users', memberH))).toBe(200)
    })

    it('shows an app\'s groups only to people who manage apps or groups', async () => {
      const { org, adminH, memberH } = await setup()
      const group = await createGroup(org.slug, adminH)
      await $fetch(`/api/o/${org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [group.id] }, ...adminH })
      const { apps } = await $fetch<{ apps: { appId: string, groups: string[] }[] }>(`/api/o/${org.slug}/apps`, memberH)
      expect(apps.every(a => a.groups.length === 0)).toBe(true)
    })

    it('refuses to delete a group while an app\'s access names it', async () => {
      const { org, adminH } = await setup()
      const group = await createGroup(org.slug, adminH)
      await $fetch(`/api/o/${org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [group.id] }, ...adminH })

      expect(await status($fetch(`/api/o/${org.slug}/groups/${group.id}`, { method: 'DELETE', ...adminH }))).toBe(409)
      const [gate] = await sql`SELECT 1 FROM app_groups WHERE group_id = ${group.id}`
      expect(gate).toBeTruthy()

      await $fetch(`/api/o/${org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [] }, ...adminH })
      await $fetch(`/api/o/${org.slug}/groups/${group.id}`, { method: 'DELETE', ...adminH })
    })

    it('refuses another org\'s group on an app\'s list', async () => {
      const a = await setup()
      const b = await setup()
      const foreign = await createGroup(b.org.slug, b.adminH)
      expect(await status($fetch(`/api/o/${a.org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [foreign.id] }, ...a.adminH }))).toBe(400)
    })

    it('needs org.apps.manage to change an app\'s groups', async () => {
      const { org, memberH } = await setup()
      expect(await status($fetch(`/api/o/${org.slug}/apps/messages/groups`, { method: 'PUT', body: { groupIds: [] }, ...memberH }))).toBe(403)
    })
  })
})
