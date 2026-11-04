// Reordering an org's portfolios over HTTP: the stored order wins over the
// alphabetical default, a portfolio created afterwards lands at the end, a
// list that doesn't cover the org is rejected, and only admins may reorder.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  addContextMember,
  createTestPortfolio,
  withOrgHeader
} from '../helpers'

interface Listed { id: string, name: string }

async function listNames(opts: ReturnType<typeof withOrgHeader>): Promise<string[]> {
  const res = await $fetch<{ portfolios: Listed[] }>('/api/context/portfolios', { ...opts })
  return res.portfolios.map(p => p.name)
}

function reorder(ids: string[], opts: ReturnType<typeof withOrgHeader>) {
  return $fetch<{ portfolios: Listed[] }>('/api/context/portfolio-order', {
    method: 'PUT',
    body: { ids },
    ...opts
  })
}

describe('PUT /api/context/portfolio-order', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('lists portfolios alphabetically until an order is set', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    await createTestPortfolio(sql, { org_id: org.id, name: 'Charlie', created_by: user.id })
    await createTestPortfolio(sql, { org_id: org.id, name: 'Alpha', created_by: user.id })
    await createTestPortfolio(sql, { org_id: org.id, name: 'Bravo', created_by: user.id })

    expect(await listNames(withOrgHeader(auth, org.slug))).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('stores the given order and returns portfolios in it', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const a = await createTestPortfolio(sql, { org_id: org.id, name: 'Alpha', created_by: user.id })
    const b = await createTestPortfolio(sql, { org_id: org.id, name: 'Bravo', created_by: user.id })
    const c = await createTestPortfolio(sql, { org_id: org.id, name: 'Charlie', created_by: user.id })
    const opts = withOrgHeader(auth, org.slug)

    const res = await reorder([c.id, a.id, b.id], opts)
    expect(res.portfolios.map(p => p.name)).toEqual(['Charlie', 'Alpha', 'Bravo'])
    expect(await listNames(opts)).toEqual(['Charlie', 'Alpha', 'Bravo'])
  })

  it('puts a portfolio created after the order was set at the end', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const b = await createTestPortfolio(sql, { org_id: org.id, name: 'Bravo', created_by: user.id })
    const c = await createTestPortfolio(sql, { org_id: org.id, name: 'Charlie', created_by: user.id })
    const opts = withOrgHeader(auth, org.slug)

    await reorder([c.id, b.id], opts)
    await $fetch('/api/context/portfolios', { method: 'POST', body: { name: 'Alpha' }, ...opts })

    expect(await listNames(opts)).toEqual(['Charlie', 'Bravo', 'Alpha'])
  })

  it('rejects a list that omits a portfolio or repeats one, leaving the order untouched', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const a = await createTestPortfolio(sql, { org_id: org.id, name: 'Alpha', created_by: user.id })
    const b = await createTestPortfolio(sql, { org_id: org.id, name: 'Bravo', created_by: user.id })
    const opts = withOrgHeader(auth, org.slug)

    const partial = await reorder([b.id], opts).catch(e => e)
    expect(partial.statusCode).toBe(400)
    const repeated = await reorder([b.id, b.id, a.id], opts).catch(e => e)
    expect(repeated.statusCode).toBe(400)

    expect(await listNames(opts)).toEqual(['Alpha', 'Bravo'])
  })

  it('rejects a portfolio from another org', async () => {
    const one = await createContextOrgWith(sql, ['admin'])
    const two = await createContextOrgWith(sql, ['admin'])
    const mine = await createTestPortfolio(sql, { org_id: one.org.id, name: 'Mine', created_by: one.user.id })
    const theirs = await createTestPortfolio(sql, { org_id: two.org.id, name: 'Theirs', created_by: two.user.id })

    const err = await reorder([theirs.id, mine.id], withOrgHeader(one.auth, one.org.slug)).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('member without context.settings gets 403', async () => {
    const { org, user } = await createContextOrgWith(sql, ['admin'])
    const m = await addContextMember(sql, org.id, ['member'])
    const a = await createTestPortfolio(sql, { org_id: org.id, name: 'Alpha', created_by: user.id })

    const err = await reorder([a.id], withOrgHeader(m.auth, org.slug)).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})

describe('Context settings page', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('shows the Settings nav item to an admin but not a member', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const m = await addContextMember(sql, org.id, ['member'])
    const navPaths = async (a: typeof auth) =>
      (await $fetch<{ items: Array<{ path: string }> }>(`/api/o/${org.slug}/_nav?app=context`, { ...a }))
        .items.map(n => n.path)

    expect(await navPaths(auth)).toContain('/context/settings')
    expect(await navPaths(m.auth)).not.toContain('/context/settings')
  })

  it('never gives a portfolio the reserved slug "settings"', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const res = await $fetch<{ slug: string }>('/api/context/portfolios', {
      method: 'POST',
      body: { name: 'Settings' },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.slug).toBe('settings-2')
  })
})
