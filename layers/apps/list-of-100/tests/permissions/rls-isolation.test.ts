// Per-user scoping. List of 100 is a personal app: a user's list is the same
// in every org, and nobody else sees it. Two layers of separation:
//   1. Handler-level `where user_id = ctx.userId`.
//   2. The `user_isolation` RLS policy, keyed on `app.current_user`.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  getAppUserDb,
  cleanupListOf100TestData,
  createListOf100OrgWith,
  addListOf100Member,
  createListOf100User,
  createTestContact,
  getAuthHeaders,
  withOrgHeader
} from '../helpers'

describe('list-of-100 per-user isolation', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('two members of the same org each see only their own contacts', async () => {
    const a = await createListOf100OrgWith(sql, ['admin'])
    const m = await addListOf100Member(sql, a.org.id, ['member'])

    await createTestContact(sql, { user_id: a.user.id, name: 'AdminA' })
    await createTestContact(sql, { user_id: a.user.id, name: 'AdminB' })
    await createTestContact(sql, { user_id: m.user.id, name: 'MemberOnly' })

    const adminRes = await $fetch<{ contacts: { name: string }[] }>(
      '/api/list-of-100/contacts',
      { ...withOrgHeader(a.auth, a.org.slug) }
    )
    expect(adminRes.contacts.map(c => c.name).sort()).toEqual(['AdminA', 'AdminB'])

    const memberRes = await $fetch<{ contacts: { name: string }[] }>(
      '/api/list-of-100/contacts',
      { ...withOrgHeader(m.auth, a.org.slug) }
    )
    expect(memberRes.contacts.map(c => c.name)).toEqual(['MemberOnly'])
  })

  it('a user\'s list is the same in every org and with no org at all', async () => {
    const a = await createListOf100OrgWith(sql, ['admin'])
    const b = await createListOf100OrgWith(sql, ['admin'])
    await sql`
      INSERT INTO memberships (id, user_id, org_id, roles)
      VALUES (gen_random_uuid(), ${a.user.id}, ${b.org.id}, ${['admin']})
    `
    await createTestContact(sql, { user_id: a.user.id, name: 'One' })
    await createTestContact(sql, { user_id: a.user.id, name: 'Two' })

    for (const opts of [withOrgHeader(a.auth, a.org.slug), withOrgHeader(a.auth, b.org.slug), a.auth]) {
      const res = await $fetch<{ contacts: { name: string }[], progress: { total: number } }>('/api/list-of-100/contacts', opts)
      expect(res.contacts.map(c => c.name).sort()).toEqual(['One', 'Two'])
      expect(res.progress.total).toBe(2)
    }
  })

  it('works for a user who belongs to no org', async () => {
    const user = await createListOf100User(sql)
    const auth = getAuthHeaders(user)
    const created = await $fetch<{ contact: { id: string } }>('/api/list-of-100/contacts', {
      method: 'POST',
      body: { name: 'Solo', relationship: 'friend', faith_status: 'unknown' },
      ...auth
    })
    const res = await $fetch<{ contacts: { id: string }[] }>('/api/list-of-100/contacts', auth)
    expect(res.contacts.map(c => c.id)).toEqual([created.contact.id])
  })

  it('RLS shows the app role only the current user\'s rows', async () => {
    const a = await createListOf100User(sql)
    const b = await createListOf100User(sql)
    await createTestContact(sql, { user_id: a.id, name: 'A1' })
    await createTestContact(sql, { user_id: b.id, name: 'B1' })

    const app = getAppUserDb()
    const rows = await app.begin(async (tx) => {
      await tx`select set_config('app.current_user', ${a.id}, true)`
      return await tx<{ name: string }[]>`
        select name from list_of_100_contacts where user_id in (${a.id}, ${b.id})
      `
    })
    expect(rows.map(r => r.name)).toEqual(['A1'])

    const none = await app.begin(async tx => await tx<{ name: string }[]>`
      select name from list_of_100_contacts where user_id in (${a.id}, ${b.id})
    `)
    expect(none).toEqual([])
  })
})
