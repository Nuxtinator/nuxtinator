import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin,
  createTenancyUser,
  getAuthHeaders,
  createTestOrg
} from '../helpers'

describe('GET /api/admin/orgs (list)', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('returns 403 when caller is not an operator admin', async () => {
    const user = await createTenancyUser(sql)
    const err = await $fetch('/api/admin/orgs', getAuthHeaders(user)).catch(e => e)
    expect(err.statusCode).toBe(403)
  })

  it('returns the org list with member_count + app_count', async () => {
    const { auth } = await createOperatorAdmin(sql)
    await createTestOrg(sql, { name: 'A Org' })
    await createTestOrg(sql, { name: 'Z Org' })

    const res = await $fetch('/api/admin/orgs', auth)
    expect(Array.isArray(res.orgs)).toBe(true)

    const created = res.orgs.filter((o: { slug: string }) => o.slug.startsWith('test-tenancy-'))
    expect(created.length).toBeGreaterThanOrEqual(2)

    for (const o of created) {
      expect(typeof o.member_count).toBe('number')
      expect(typeof o.app_count).toBe('number')
      expect(typeof o.suspended).toBe('boolean')
    }

    // Sorted by name asc
    const names = created.map((o: { name: string }) => o.name)
    expect([...names].sort()).toEqual(names)
  })

  it('counts each org\'s spam complaints from the last 30 days', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql, { name: 'Complaints Org' })
    const quiet = await createTestOrg(sql, { name: 'Quiet Org' })
    const add = (orgId: string | null, reason: string, daysAgo: number, n: number) => sql`
      INSERT INTO mail_suppressions (address_hash, org_id, scope, reason, occurred_at)
      VALUES (${`test-tenancy-${orgId}-${reason}-${daysAgo}-${n}`}, ${orgId}, ${orgId ? 'org' : 'host'}, ${reason}, now() - make_interval(days => ${daysAgo}))
    `
    await add(org.id, 'complaint', 1, 1)
    await add(org.id, 'complaint', 29, 2)
    await add(org.id, 'complaint', 31, 3)
    await add(org.id, 'hard_bounce', 1, 4)
    await add(null, 'complaint', 1, 5)

    try {
      const res = await $fetch('/api/admin/orgs', auth)
      const byId = new Map(res.orgs.map((o: { id: string, complaint_count: number }) => [o.id, o.complaint_count]))
      expect(byId.get(org.id)).toBe(2)
      expect(byId.get(quiet.id)).toBe(0)
    } finally {
      await sql`DELETE FROM mail_suppressions WHERE address_hash LIKE 'test-tenancy-%'`
    }
  })
})
