// Turning a personal app on for a user: a host admin's grant, or an invite
// that carries the app. List of 100 is the personal app under test.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupListOf100TestData,
  createListOf100User,
  createPendingInvite,
  getAuthHeaders
} from '../helpers'

async function hasGrant(sql: ReturnType<typeof getHostAdminDb>, userId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM user_apps WHERE user_id = ${userId} AND app_id = 'list-of-100'`
  return rows.length > 0
}

describe('personal app grants', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('host admin turns the app on and off for a user', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const user = await createListOf100User(sql, { grant: false })
    const auth = getAuthHeaders(admin)

    const before = await $fetch<{ apps: { id: string, enabled: boolean, granted: boolean }[] }>(`/api/admin/users/${user.id}/apps`, auth)
    expect(before.apps.find(a => a.id === 'list-of-100')).toMatchObject({ enabled: false, granted: false })

    await $fetch(`/api/admin/users/${user.id}/apps/list-of-100`, { method: 'PUT', body: { granted: true }, ...auth })
    expect(await hasGrant(sql, user.id)).toBe(true)
    await $fetch('/api/list-of-100/contacts', getAuthHeaders(user))

    await $fetch(`/api/admin/users/${user.id}/apps/list-of-100`, { method: 'PUT', body: { granted: false }, ...auth })
    expect(await hasGrant(sql, user.id)).toBe(false)
    const err = await $fetch('/api/list-of-100/contacts', getAuthHeaders(user)).catch(e => e)
    expect(err.statusCode).toBe(410)
  })

  it('refuses to grant an org app or a non-admin caller', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const user = await createListOf100User(sql, { grant: false })

    const orgApp = await $fetch(`/api/admin/users/${user.id}/apps/messages`, {
      method: 'PUT', body: { granted: true }, ...getAuthHeaders(admin)
    }).catch(e => e)
    expect(orgApp.statusCode).toBe(404)

    const notAdmin = await $fetch(`/api/admin/users/${user.id}/apps/list-of-100`, {
      method: 'PUT', body: { granted: true }, ...getAuthHeaders(user)
    }).catch(e => e)
    expect(notAdmin.statusCode).toBe(403)
  })

  it('an invite with only a personal app (no org) is accepted into a grant', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const email = `test-list-of-100-${randomUUID().slice(0, 8)}@example.com`

    const res = await $fetch<{ invite: { id: string } }>('/api/admin/users/invite', {
      method: 'POST',
      body: { email, apps: ['list-of-100'] },
      ...getAuthHeaders(admin)
    })
    const rows = await sql<{ app_id: string }[]>`SELECT app_id FROM invite_apps WHERE invite_id = ${res.invite.id}`
    expect(rows.map(r => r.app_id)).toEqual(['list-of-100'])

    // Accept through a seeded token for the same address (the emailed token
    // isn't readable here).
    await sql`DELETE FROM invites WHERE id = ${res.invite.id}`
    const invite = await createPendingInvite(sql, { email, apps: ['list-of-100'], invitedBy: admin.id })
    const accept = await fetch('/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.token, password: 'newpassword123', display_name: 'Invited' })
    })
    expect(accept.status).toBe(200)
    expect((await accept.json()).redirect).toBe('/dashboard')

    const [created] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`
    const [grant] = await sql<{ granted_by: string | null }[]>`SELECT granted_by FROM user_apps WHERE user_id = ${created!.id} AND app_id = 'list-of-100'`
    expect(grant?.granted_by).toBe(admin.id)
  })

  it('an invite naming an unknown or org app is rejected', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const err = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: { email: `test-list-of-100-${randomUUID().slice(0, 8)}@example.com`, apps: ['messages'] },
      ...getAuthHeaders(admin)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('an existing user invited with a personal app gets the grant straight away', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const user = await createListOf100User(sql, { grant: false })
    await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: { email: user.email, apps: ['list-of-100'] },
      ...getAuthHeaders(admin)
    })
    expect(await hasGrant(sql, user.id)).toBe(true)
  })
})

describe('GET /api/admin/apps/:appId/users', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('lists users with granted ones first and filters by search', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false, display_name: 'Zed Admin' })
    const granted = await createListOf100User(sql, { display_name: 'Zz Granted' })
    const other = await createListOf100User(sql, { grant: false, display_name: 'Aa Other' })
    const auth = getAuthHeaders(admin)

    const res = await $fetch<{ users: { id: string, granted: boolean, enabled: boolean }[] }>('/api/admin/apps/list-of-100/users', {
      query: { q: 'test-list-of-100-' }, ...auth
    })
    const ids = res.users.map(u => u.id)
    expect(ids.indexOf(granted.id)).toBeLessThan(ids.indexOf(other.id))
    expect(res.users.find(u => u.id === granted.id)).toMatchObject({ granted: true, enabled: true })
    expect(res.users.find(u => u.id === other.id)).toMatchObject({ granted: false, enabled: false })

    const filtered = await $fetch<{ users: { id: string }[] }>('/api/admin/apps/list-of-100/users', {
      query: { q: other.email }, ...auth
    })
    expect(filtered.users.map(u => u.id)).toEqual([other.id])
  })

  it('404s for an org app and 403s for non-admins', async () => {
    const admin = await createListOf100User(sql, { is_admin: true, grant: false })
    const user = await createListOf100User(sql)
    expect((await $fetch('/api/admin/apps/messages/users', getAuthHeaders(admin)).catch(e => e)).statusCode).toBe(404)
    expect((await $fetch('/api/admin/apps/list-of-100/users', getAuthHeaders(user)).catch(e => e)).statusCode).toBe(403)
  })
})
