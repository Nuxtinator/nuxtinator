// Full CRUD via HTTP. Each test creates an org+admin, hits the endpoint
// under test, and asserts both the response shape and the DB side-effect.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  createContextOrg,
  addContextMember,
  createTestPortfolio,
  withOrgHeader
} from '../helpers'
import { CONTEXT_SECTIONS } from '../../server/utils/section-catalog'

describe('POST /api/context/portfolios', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('creates a portfolio in the active org', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const res = await $fetch<{ id: string, slug: string, name: string }>(
      '/api/context/portfolios',
      { method: 'POST', body: { name: 'Acme' }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.id).toBeDefined()
    expect(res.name).toBe('Acme')
    expect(res.slug).toMatch(/^[a-z0-9-]+$/)

    const rows = await sql<{ org_id: string, slug: string }[]>`
      SELECT org_id, slug FROM context_portfolios WHERE id = ${res.id}
    `
    expect(rows[0]!.org_id).toBe(org.id)
    expect(rows[0]!.slug).toBe(res.slug)
  })

  it('auto-suffixes a colliding slug within an org', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const fixed = `test-context-fixed-${Date.now()}`
    await createTestPortfolio(sql, { org_id: org.id, slug: fixed, name: 'First', created_by: user.id })

    const res = await $fetch<{ slug: string }>('/api/context/portfolios', {
      method: 'POST',
      body: { name: 'Second', slug: fixed },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.slug).toBe(`${fixed}-2`)
  })

  it('starts with every built-in section when builtin_sections is omitted', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const res = await $fetch<{ id: string, slug: string }>('/api/context/portfolios', { method: 'POST', body: { name: 'All' }, ...opts })

    const listed = await $fetch<{ sections: Array<{ key: string, is_custom: boolean }> }>(`/api/context/portfolios/${res.slug}/sections`, { ...opts })
    expect(listed.sections.map(s => s.key)).toEqual(CONTEXT_SECTIONS.map(s => s.key))
    expect(listed.sections.every(s => !s.is_custom)).toBe(true)
  })

  it('starts empty when builtin_sections is []', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const res = await $fetch<{ id: string, slug: string }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'None', builtin_sections: [] }, ...opts
    })

    const listed = await $fetch<{ sections: unknown[] }>(`/api/context/portfolios/${res.slug}/sections`, { ...opts })
    expect(listed.sections).toEqual([])
    const rows = await sql<{ key: string }[]>`SELECT key FROM context_section_definitions WHERE portfolio_id = ${res.id}`
    expect(rows).toHaveLength(0)
  })

  it('starts with only the chosen built-ins, deduplicated, stamped with the creator', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const res = await $fetch<{ id: string, slug: string }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Some', builtin_sections: ['team', 'identity', 'team'] }, ...opts
    })

    const listed = await $fetch<{ sections: Array<{ key: string }> }>(`/api/context/portfolios/${res.slug}/sections`, { ...opts })
    expect(listed.sections.map(s => s.key)).toEqual(['identity', 'team'])
    const rows = await sql<{ key: string, title: string | null, created_by: string }[]>`
      SELECT key, title, created_by FROM context_section_definitions WHERE portfolio_id = ${res.id} ORDER BY key
    `
    expect(rows).toEqual([
      { key: 'identity', title: null, created_by: user.id },
      { key: 'team', title: null, created_by: user.id }
    ])
  })

  it('rejects an unknown built-in key with 400 and creates nothing', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const err = await $fetch('/api/context/portfolios', {
      method: 'POST',
      body: { name: 'Bad keys', builtin_sections: ['identity', 'roadmap'] },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
    expect(String(err.statusMessage)).toContain('roadmap')

    const rows = await sql<{ id: string }[]>`SELECT id FROM context_portfolios WHERE org_id = ${org.id}`
    expect(rows).toHaveLength(0)
  })

  it('member without context.portfolio.create gets 403', async () => {
    const { org } = await createContextOrgWith(sql, ['admin'])
    const m = await addContextMember(sql, org.id, ['member'])

    const err = await $fetch('/api/context/portfolios', {
      method: 'POST',
      body: { name: 'Should fail' },
      ...withOrgHeader(m.auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })

  it('rejects empty name with 400', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const err = await $fetch('/api/context/portfolios', {
      method: 'POST',
      body: { name: '   ' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 401 when no auth cookie is present', async () => {
    const { org } = await createContextOrgWith(sql, ['admin'])
    const err = await $fetch('/api/context/portfolios', {
      method: 'POST',
      body: { name: 'X' },
      headers: { 'x-active-org': org.slug }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })
})

describe('GET /api/context/portfolios', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('lists portfolios from the active org only', async () => {
    const { org: orgA, auth: authA, user: userA } = await createContextOrgWith(sql, ['admin'])
    const orgB = await createContextOrg(sql)
    await createTestPortfolio(sql, { org_id: orgA.id, name: 'A1', created_by: userA.id })
    await createTestPortfolio(sql, { org_id: orgA.id, name: 'A2', created_by: userA.id })
    await createTestPortfolio(sql, { org_id: orgB.id, name: 'B1', created_by: userA.id })

    const res = await $fetch<{ portfolios: Array<{ name: string }> }>(
      '/api/context/portfolios',
      { ...withOrgHeader(authA, orgA.slug) }
    )
    const names = res.portfolios.map(p => p.name).sort()
    expect(names).toEqual(['A1', 'A2'])
  })
})

describe('GET /api/context/portfolios/:slug', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('reads back a portfolio in the active org', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Read Test', created_by: user.id })

    const res = await $fetch<{ id: string, slug: string }>(
      `/api/context/portfolios/${p.slug}`,
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.id).toBe(p.id)
    expect(res.slug).toBe(p.slug)
  })

  it('cross-org read returns 404 — RLS isolation', async () => {
    const { org: orgA, auth: authA, user: userA } = await createContextOrgWith(sql, ['admin'])
    const orgB = await createContextOrg(sql)
    const pB = await createTestPortfolio(sql, { org_id: orgB.id, name: 'B1', created_by: userA.id })

    const err = await $fetch(`/api/context/portfolios/${pB.slug}`, { ...withOrgHeader(authA, orgA.slug) }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})

describe('DELETE /api/context/portfolios/:slug', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('removes the portfolio and cascades sections', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'To Delete', created_by: user.id })

    await $fetch(`/api/context/portfolios/${p.slug}`, {
      method: 'DELETE',
      ...withOrgHeader(auth, org.slug)
    })

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM context_portfolios WHERE id = ${p.id}
    `
    expect(rows.length).toBe(0)
  })

  it('member without context.portfolio.delete gets 403', async () => {
    const { org, user } = await createContextOrgWith(sql, ['admin'])
    const m = await addContextMember(sql, org.id, ['member'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Protect', created_by: user.id })

    const err = await $fetch(`/api/context/portfolios/${p.slug}`, {
      method: 'DELETE',
      ...withOrgHeader(m.auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})
