// Library admin API: CRUD, kind rules, the delete guard while a widget lists
// a library, and cross-org invisibility.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupHelpinatorTestData,
  createHelpinatorOrgWith,
  addHelpinatorMember,
  seedPortfolio,
  seedLibrary,
  seedWidget
} from '../helpers'

describe('libraries admin API', () => {
  const sql = getHostAdminDb()
  beforeEach(async () => {
    await cleanupHelpinatorTestData(sql)
  })
  afterEach(async () => {
    await cleanupHelpinatorTestData(sql)
  })

  it('creates, lists, updates and deletes a website library', async () => {
    const { opts } = await createHelpinatorOrgWith(sql)
    const created = await $fetch<{ id: string, kind: string, name: string }>('/api/helpinator/libraries', {
      method: 'POST', body: { name: 'Docs', kind: 'website', description: 'The docs site' }, ...opts
    })
    expect(created.kind).toBe('website')

    const list = await $fetch<Array<{ id: string, stats: { pages: number }, source_count: number }>>('/api/helpinator/libraries', { ...opts })
    expect(list.map(l => l.id)).toContain(created.id)
    expect(list.find(l => l.id === created.id)!.stats.pages).toBe(0)

    const updated = await $fetch<{ name: string }>(`/api/helpinator/libraries/${created.id}`, {
      method: 'PUT', body: { name: 'Docs v2', kind: 'website', description: '' }, ...opts
    })
    expect(updated.name).toBe('Docs v2')

    const kindChange = await $fetch(`/api/helpinator/libraries/${created.id}`, {
      method: 'PUT', body: { name: 'x', kind: 'portfolio', portfolio_id: null }, ...opts
    }).catch(e => e)
    expect(kindChange.statusCode).toBe(400)

    await $fetch(`/api/helpinator/libraries/${created.id}`, { method: 'DELETE', ...opts })
    expect((await $fetch(`/api/helpinator/libraries/${created.id}`, { ...opts }).catch(e => e)).statusCode).toBe(404)
  })

  it('a portfolio library needs a portfolio of this org', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const other = await createHelpinatorOrgWith(sql)
    const foreign = await seedPortfolio(sql, other.org.id, 'Foreign', { faq: 'x' })
    const mine = await seedPortfolio(sql, org.id, 'Mine', { faq: 'x' })

    expect((await $fetch('/api/helpinator/libraries', { method: 'POST', body: { name: 'P', kind: 'portfolio' }, ...opts }).catch(e => e)).statusCode).toBe(400)
    expect((await $fetch('/api/helpinator/libraries', { method: 'POST', body: { name: 'P', kind: 'portfolio', portfolio_id: foreign.id }, ...opts }).catch(e => e)).statusCode).toBe(400)
    const ok = await $fetch<{ portfolio_id: string }>('/api/helpinator/libraries', { method: 'POST', body: { name: 'P', kind: 'portfolio', portfolio_id: mine.id }, ...opts })
    expect(ok.portfolio_id).toBe(mine.id)
  })

  it('refuses to delete a library a widget lists', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'P', { faq: 'x' })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: p.id, sectionKey: 'faq' })
    const err = await $fetch(`/api/helpinator/libraries/${widget.libraryId}`, { method: 'DELETE', ...opts }).catch(e => e)
    expect(err.statusCode).toBe(409)
    await sql`DELETE FROM helpinator_widgets WHERE id = ${widget.id}`
    await $fetch(`/api/helpinator/libraries/${widget.libraryId}`, { method: 'DELETE', ...opts })
  })

  it('URLs only go on website libraries and must be http(s)', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'P', { faq: 'x' })
    const portfolioLib = await seedLibrary(sql, { orgId: org.id, portfolioId: p.id })
    expect((await $fetch(`/api/helpinator/libraries/${portfolioLib.id}/sources`, { method: 'POST', body: { url: 'https://example.org' }, ...opts }).catch(e => e)).statusCode).toBe(400)
    const site = await seedLibrary(sql, { orgId: org.id, kind: 'website' })
    expect((await $fetch(`/api/helpinator/libraries/${site.id}/sources`, { method: 'POST', body: { url: 'ftp://example.org' }, ...opts }).catch(e => e)).statusCode).toBe(400)
  })

  it('is invisible across orgs and needs helpinator.manage', async () => {
    const a = await createHelpinatorOrgWith(sql)
    const b = await createHelpinatorOrgWith(sql)
    const lib = await seedLibrary(sql, { orgId: a.org.id, kind: 'website' })
    expect((await $fetch(`/api/helpinator/libraries/${lib.id}`, { ...b.opts }).catch(e => e)).statusCode).toBe(404)
    const { opts: member } = await addHelpinatorMember(sql, a.org)
    expect((await $fetch('/api/helpinator/libraries', { ...member }).catch(e => e)).statusCode).toBe(403)
  })

  it('helpinator.manage without context.read cannot reach portfolios', async () => {
    const { org } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'Private Notes', { faq: 'secret' })
    const portfolioLib = await seedLibrary(sql, { orgId: org.id, kind: 'portfolio', portfolioId: p.id })
    const { user, opts } = await addHelpinatorMember(sql, org, [])
    for (const perm of ['helpinator.access', 'helpinator.read', 'helpinator.manage']) {
      await sql`INSERT INTO user_permission_grants (id, user_id, permission, org_id) VALUES (gen_random_uuid(), ${user.id}, ${perm}, ${org.id})`
    }

    expect((await $fetch('/api/helpinator/portfolios', { ...opts }).catch(e => e)).statusCode).toBe(403)
    const create = await $fetch('/api/helpinator/libraries', {
      method: 'POST', body: { name: 'Leak', kind: 'portfolio', portfolio_id: p.id }, ...opts
    }).catch(e => e)
    expect(create.statusCode).toBe(403)
    const widget = await $fetch('/api/helpinator/widgets', {
      method: 'POST',
      body: { name: 'Leak', allowed_origins: ['https://evil.example'], library_ids: [portfolioLib.id], default_library_id: portfolioLib.id },
      ...opts
    }).catch(e => e)
    expect(widget.statusCode).toBe(403)

    // Website libraries need nothing from context.
    const site = await $fetch<{ id: string }>('/api/helpinator/libraries', { method: 'POST', body: { name: 'Docs', kind: 'website' }, ...opts })
    expect(site.id).toBeTruthy()
  })
})
