// Access gate. List of 100 is a personal app whose registered status is
// invite-only: a user without a `user_apps` grant gets 410 from every
// endpoint, whatever their org roles. A host admin setting the status to
// 'default' turns it on for everyone.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupListOf100TestData,
  createListOf100User,
  createListOf100Org,
  addTestMembership,
  getAuthHeaders,
  withOrgHeader
} from '../helpers'

const ENDPOINTS: Array<{ method: 'GET' | 'POST', path: string, body?: Record<string, unknown> }> = [
  { method: 'POST', path: '/api/list-of-100/contacts', body: { name: 'X', relationship: 'friend', faith_status: 'unknown' } },
  { method: 'GET', path: '/api/list-of-100/contacts' },
  { method: 'GET', path: '/api/list-of-100/progress' },
  { method: 'GET', path: '/api/list-of-100/insights' },
  { method: 'POST', path: '/api/list-of-100/contacts/00000000-0000-0000-0000-000000000000/mark-contacted' },
  { method: 'POST', path: '/api/list-of-100/contacts/00000000-0000-0000-0000-000000000000/mark-prayed' },
  { method: 'GET', path: '/api/list-of-100/contacts/00000000-0000-0000-0000-000000000000/history' }
]

describe('list-of-100 access gate', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('410 on every endpoint for a user without a grant, even an org admin', async () => {
    const user = await createListOf100User(sql, { grant: false })
    const org = await createListOf100Org(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })
    const auth = getAuthHeaders(user)

    for (const e of ENDPOINTS) {
      const err = await $fetch(e.path, { method: e.method, body: e.body, ...withOrgHeader(auth, org.slug) }).catch(err => err)
      expect(err.statusCode, `${e.method} ${e.path}`).toBe(410)
    }
  })

  it('org roles never carry its permissions, even the admin role', async () => {
    const user = await createListOf100User(sql)
    const org = await createListOf100Org(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })
    const res = await $fetch<{ perms: string[] }>(`/api/o/${org.slug}/_perms`, getAuthHeaders(user))
    expect(res.perms.filter(p => p.startsWith('list-of-100.'))).toEqual([])
  })

  it('the personal-apps feed lists the app only for granted users', async () => {
    const granted = await createListOf100User(sql)
    const notGranted = await createListOf100User(sql, { grant: false })

    const yes = await $fetch<{ apps: { id: string }[] }>('/api/_personal-apps', getAuthHeaders(granted))
    expect(yes.apps.map(a => a.id)).toContain('list-of-100')

    const no = await $fetch<{ apps: { id: string }[] }>('/api/_personal-apps', getAuthHeaders(notGranted))
    expect(no.apps.map(a => a.id)).not.toContain('list-of-100')
  })

  it('status \'default\' turns it on for users without a grant', async () => {
    const [before] = await sql<{ status: string | null }[]>`SELECT status FROM apps WHERE id = 'list-of-100'`
    const user = await createListOf100User(sql, { grant: false })
    try {
      await sql`INSERT INTO apps (id, status) VALUES ('list-of-100', 'default') ON CONFLICT (id) DO UPDATE SET status = 'default'`
      const res = await $fetch<{ contacts: unknown[] }>('/api/list-of-100/contacts', getAuthHeaders(user))
      expect(res.contacts).toEqual([])
    } finally {
      await sql`UPDATE apps SET status = ${before?.status ?? null} WHERE id = 'list-of-100'`
    }
  })
})
