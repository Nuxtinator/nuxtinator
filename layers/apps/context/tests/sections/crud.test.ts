// Section save / read / version / restore via the HTTP routes. Each save
// snapshots a version row; restore reads a named version and saves it as a
// new head version. Size cap and unknown-key behaviors live here too.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  createTestPortfolio,
  withOrgHeader
} from '../helpers'

describe('PUT /api/context/portfolios/:slug/sections/:key', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('saves content and writes a version row', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Sections', created_by: user.id })

    const res = await $fetch<{ id: string, key: string, version_id: string }>(
      `/api/context/portfolios/${p.slug}/sections/identity`,
      { method: 'PUT', body: { content: 'We are Acme.' }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.key).toBe('identity')
    expect(res.version_id).toBeDefined()

    const rows = await sql<{ content: string }[]>`
      SELECT content FROM context_sections WHERE id = ${res.id}
    `
    expect(rows[0]!.content).toBe('We are Acme.')

    const vrows = await sql<{ id: string, source: string | null }[]>`
      SELECT id, source FROM context_section_versions WHERE section_id = ${res.id}
    `
    expect(vrows.length).toBe(1)
    expect(vrows[0]!.source).toBe('user')

    const listed = await $fetch<{ versions: Array<{ id: string, source: string | null }> }>(
      `/api/context/portfolios/${p.slug}/sections/identity/versions`,
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(listed.versions).toHaveLength(1)
    expect(listed.versions[0]).toMatchObject({ id: res.version_id, source: 'user' })
  })

  it('subsequent saves append versions; restore returns a prior version as the new head', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Restore Test', created_by: user.id })

    const first = await $fetch<{ id: string, version_id: string }>(
      `/api/context/portfolios/${p.slug}/sections/identity`,
      { method: 'PUT', body: { content: 'v1' }, ...withOrgHeader(auth, org.slug) }
    )
    await $fetch(
      `/api/context/portfolios/${p.slug}/sections/identity`,
      { method: 'PUT', body: { content: 'v2' }, ...withOrgHeader(auth, org.slug) }
    )

    const restored = await $fetch<{ content: string, version_id: string }>(
      `/api/context/portfolios/${p.slug}/sections/identity/versions/${first.version_id}/restore`,
      { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )
    expect(restored.content).toBe('v1')
    expect(restored.version_id).not.toBe(first.version_id)

    const vrows = await sql<{ id: string, source: string | null }[]>`
      SELECT id, source FROM context_section_versions WHERE section_id = ${first.id}
    `
    expect(vrows.length).toBe(3)
    expect(vrows.find(v => v.id === restored.version_id)!.source).toBe('user')
  })

  it('rejects > 100KB body with 413', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Big', created_by: user.id })
    const tooBig = 'a'.repeat(100 * 1024 + 1)

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, {
      method: 'PUT',
      body: { content: tooBig },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(413)
  })

  it('rejects unknown section key with 404', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Unknown', created_by: user.id })

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections/this-does-not-exist`, {
      method: 'PUT',
      body: { content: 'x' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})

describe('GET /api/context/portfolios/:slug/sections/:key', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('returns the section content + catalog metadata', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Read', created_by: user.id })
    await $fetch(
      `/api/context/portfolios/${p.slug}/sections/identity`,
      { method: 'PUT', body: { content: 'We make X.' }, ...withOrgHeader(auth, org.slug) }
    )

    const res = await $fetch<{ content: string, key: string, title: string }>(
      `/api/context/portfolios/${p.slug}/sections/identity`,
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.content).toBe('We make X.')
    expect(res.key).toBe('identity')
    expect(res.title).toBe('Identity')
  })
})
