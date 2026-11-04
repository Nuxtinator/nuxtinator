// Portfolios created from `test-context-template` (tests/fixtures/register-test-template.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  createContextUser,
  createContextOrg,
  addTestMembership,
  createTestPortfolio,
  issueMcpBearer,
  callMcpTool,
  withOrgHeader
} from '../helpers'
import { CONTEXT_SECTIONS } from '../../server/utils/section-catalog'

const TEMPLATE = 'test-context-template'

interface ListedSection {
  key: string
  title: string
  description: string
  order: number
  is_custom: boolean
}

interface SectionList {
  sections: ListedSection[]
  missing_builtins: Array<{ key: string, title: string, description: string }>
}

const sql = getHostAdminDb()

async function setup() {
  const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
  return { org, user, opts: withOrgHeader(auth, org.slug) }
}

describe('portfolio templates', () => {
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-context-%'`
  })

  it('creates a portfolio from a registered template, storing only keys', async () => {
    const { opts } = await setup()
    const res = await $fetch<{ id: string, slug: string, template: string | null }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Translation', template: TEMPLATE }, ...opts
    })
    expect(res.template).toBe(TEMPLATE)

    const [portfolio] = await sql<{ template: string | null }[]>`SELECT template FROM context_portfolios WHERE id = ${res.id}`
    expect(portfolio!.template).toBe(TEMPLATE)

    const rows = await sql<{ key: string, title: string | null, description: string | null, order: number | null }[]>`
      SELECT key, title, description, "order" FROM context_section_definitions WHERE portfolio_id = ${res.id} ORDER BY key
    `
    expect(rows).toEqual([
      { key: 'checking', title: null, description: null, order: null },
      { key: 'source-texts', title: null, description: null, order: null },
      { key: 'team', title: null, description: null, order: null }
    ])
  })

  it('resolves template section titles, descriptions, and order from code', async () => {
    const { opts } = await setup()
    const res = await $fetch<{ slug: string }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Translation', template: TEMPLATE }, ...opts
    })

    const listed = await $fetch<SectionList>(`/api/context/portfolios/${res.slug}/sections`, { ...opts })
    expect(listed.sections.map(({ key, title, description, order, is_custom }) => ({ key, title, description, order, is_custom }))).toEqual([
      { key: 'source-texts', title: 'Source Texts', description: 'Which source texts the project translates from', order: 1, is_custom: false },
      { key: 'team', title: 'Translation Team', description: 'Who translates, checks, and reviews', order: 2, is_custom: false },
      { key: 'checking', title: 'Checking Process', description: 'How drafts are checked before publication', order: 3, is_custom: false }
    ])
    expect(listed.missing_builtins).toEqual([])

    const one = await $fetch<{ title: string }>(`/api/context/portfolios/${res.slug}/sections/team`, { ...opts })
    expect(one.title).toBe('Translation Team')
  })

  it('validates builtin_sections against the chosen template', async () => {
    const { opts } = await setup()
    const err = await $fetch('/api/context/portfolios', {
      method: 'POST', body: { name: 'Bad', template: TEMPLATE, builtin_sections: ['identity'] }, ...opts
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
    expect(err.statusMessage).toContain('identity')

    const res = await $fetch<{ slug: string }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Some', template: TEMPLATE, builtin_sections: ['team'] }, ...opts
    })
    const listed = await $fetch<SectionList>(`/api/context/portfolios/${res.slug}/sections`, { ...opts })
    expect(listed.sections.map(s => s.key)).toEqual(['team'])
    expect(listed.missing_builtins.map(s => s.key)).toEqual(['source-texts', 'checking'])
    expect(listed.missing_builtins[0]!.title).toBe('Source Texts')
  })

  it('adds built-ins from the template only, and lets custom keys reuse default-catalog keys', async () => {
    const { opts } = await setup()
    const res = await $fetch<{ slug: string }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Some', template: TEMPLATE, builtin_sections: [] }, ...opts
    })
    const base = `/api/context/portfolios/${res.slug}/sections`

    const added = await $fetch<ListedSection>(base, { method: 'POST', body: { key: 'checking' }, ...opts })
    expect(added).toMatchObject({ key: 'checking', title: 'Checking Process', is_custom: false })

    const notBuiltin = await $fetch(base, { method: 'POST', body: { key: 'identity' }, ...opts }).catch(e => e)
    expect(notBuiltin.statusCode).toBe(400)

    const collides = await $fetch(base, { method: 'POST', body: { title: 'Team' }, ...opts }).catch(e => e)
    expect(collides.statusCode).toBe(409)

    const custom = await $fetch<ListedSection>(base, { method: 'POST', body: { title: 'Identity' }, ...opts })
    expect(custom).toMatchObject({ key: 'identity', title: 'Identity', is_custom: true })
  })

  it('keeps a custom section custom when the template declares its key', async () => {
    const { opts } = await setup()
    const res = await $fetch<{ id: string, slug: string }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Some', template: TEMPLATE, builtin_sections: [] }, ...opts
    })
    const base = `/api/context/portfolios/${res.slug}/sections`
    await $fetch(base, { method: 'POST', body: { title: 'Identity', description: 'Ours' }, ...opts })

    // The default template declares `identity`.
    await sql`UPDATE context_portfolios SET template = NULL WHERE id = ${res.id}`

    const listed = await $fetch<SectionList>(base, { ...opts })
    expect(listed.sections).toHaveLength(1)
    expect(listed.sections[0]).toMatchObject({ key: 'identity', title: 'Identity', description: 'Ours', is_custom: true })

    const deleted = await $fetch<{ is_custom: boolean }>(`${base}/identity`, { method: 'DELETE', ...opts })
    expect(deleted.is_custom).toBe(true)
  })

  it('lists registered templates with the default first', async () => {
    const { opts } = await setup()
    const res = await $fetch<{ templates: Array<{ id: string, label: string, sections: Array<{ key: string, title: string }> }> }>('/api/context/templates', { ...opts })
    expect(res.templates[0]!.id).toBe('default')
    expect(res.templates[0]!.sections.map(s => s.key)).toEqual(CONTEXT_SECTIONS.map(s => s.key))
    const test = res.templates.find(t => t.id === TEMPLATE)!
    expect(test.sections.map(s => s.title)).toEqual(['Source Texts', 'Translation Team', 'Checking Process'])
  })

  it('leaves default portfolios on the built-in catalog', async () => {
    const { opts } = await setup()
    const res = await $fetch<{ id: string, slug: string, template: string | null }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Org' }, ...opts
    })
    expect(res.template).toBeNull()

    const explicit = await $fetch<{ id: string, template: string | null }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Org 2', template: 'default' }, ...opts
    })
    expect(explicit.template).toBeNull()

    const listed = await $fetch<SectionList>(`/api/context/portfolios/${res.slug}/sections`, { ...opts })
    expect(listed.sections.map(s => ({ key: s.key, title: s.title, order: s.order }))).toEqual(
      CONTEXT_SECTIONS.map(s => ({ key: s.key, title: s.title, order: s.order }))
    )
    expect(listed.sections.find(s => s.key === 'team')!.title).toBe('Team')
  })

  it('rejects an unknown template id and creates nothing', async () => {
    const { org, opts } = await setup()
    const err = await $fetch('/api/context/portfolios', {
      method: 'POST', body: { name: 'Nope', template: 'no-such-template' }, ...opts
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
    expect(err.statusMessage).toContain('no-such-template')

    const rows = await sql`SELECT id FROM context_portfolios WHERE org_id = ${org.id}`
    expect(rows).toHaveLength(0)
  })

  it('reads keys of a template that is no longer registered as orphans', async () => {
    const { org, user, opts } = await setup()
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id, builtin_sections: ['source-texts'] })
    await sql`UPDATE context_portfolios SET template = 'test-context-gone' WHERE id = ${p.id}`

    const listed = await $fetch<SectionList>(`/api/context/portfolios/${p.slug}/sections`, { ...opts })
    expect(listed.sections).toHaveLength(1)
    expect(listed.sections[0]).toMatchObject({ key: 'source-texts', title: 'source-texts', is_custom: true })
    expect(listed.missing_builtins).toEqual([])
  })

  it('MCP create_portfolio takes a template', async () => {
    const user = await createContextUser(sql)
    const org = await createContextOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })
    const token = await issueMcpBearer(sql, user.id, ['context.read', 'context.portfolio.create'])

    const created = await callMcpTool(token, 'create_portfolio', { org: org.slug, name: 'test-context MCP', template: TEMPLATE })
    expect(created.isError, created.content[0]?.text).toBeFalsy()
    const portfolio = created.structuredContent?.portfolio as { id: string, template: string }
    expect(portfolio.template).toBe(TEMPLATE)

    const listed = await callMcpTool(token, 'list_sections', { org: org.slug, portfolio_id: portfolio.id })
    const sections = listed.structuredContent?.sections as Array<{ key: string, title: string }>
    expect(sections.map(s => s.title)).toEqual(['Source Texts', 'Translation Team', 'Checking Process'])

    const bad = await callMcpTool(token, 'create_portfolio', { org: org.slug, name: 'test-context Bad', template: 'no-such-template' })
    expect(bad.isError).toBe(true)
  })
})
