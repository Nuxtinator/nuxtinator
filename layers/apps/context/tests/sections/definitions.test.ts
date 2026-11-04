// Section definitions via HTTP: adding built-ins by key and customs by title,
// deleting either kind by key, and what a deleted section's key no longer
// reaches. Content saved under a deleted key survives and resurfaces when the
// section is added again.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import JSZip from 'jszip'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  addContextMember,
  createTestPortfolio,
  seedTestSection,
  withOrgHeader
} from '../helpers'
import { CONTEXT_SECTIONS } from '../../server/utils/section-catalog'

interface SectionMeta { key: string, title: string, is_custom: boolean, order: number, has_content: boolean }

async function listSections(slug: string, opts: ReturnType<typeof withOrgHeader>): Promise<SectionMeta[]> {
  const res = await $fetch<{ sections: SectionMeta[] }>(`/api/context/portfolios/${slug}/sections`, { ...opts })
  return res.sections
}

describe('POST /api/context/portfolios/:slug/sections', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('creates a custom section with a slugified key', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Customs', created_by: user.id })

    const res = await $fetch<{ id: string, key: string, title: string, is_custom: boolean }>(
      `/api/context/portfolios/${p.slug}/sections`,
      { method: 'POST', body: { title: 'Roadmap' }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.key).toBe('roadmap')
    expect(res.title).toBe('Roadmap')
    expect(res.is_custom).toBe(true)
  })

  it('rejects a custom title that collides with a built-in key with 409', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Builtin Clash', created_by: user.id, builtin_sections: [] })

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST',
      body: { title: 'Identity' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('rejects duplicate custom key within a portfolio with 409', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Dup', created_by: user.id })

    await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST',
      body: { title: 'Culture' },
      ...withOrgHeader(auth, org.slug)
    })
    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST',
      body: { title: 'Culture' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('two portfolios in the same org can share a custom key', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const pA = await createTestPortfolio(sql, { org_id: org.id, name: 'A', created_by: user.id })
    const pB = await createTestPortfolio(sql, { org_id: org.id, name: 'B', created_by: user.id })

    await $fetch(`/api/context/portfolios/${pA.slug}/sections`, {
      method: 'POST',
      body: { title: 'Roadmap' },
      ...withOrgHeader(auth, org.slug)
    })
    const res = await $fetch<{ key: string }>(
      `/api/context/portfolios/${pB.slug}/sections`,
      { method: 'POST', body: { title: 'Roadmap' }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.key).toBe('roadmap')
  })

  it('rejects title with no alphanumerics with 400', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Bad title', created_by: user.id })

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST',
      body: { title: '   ' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('adds a built-in by key, listed in catalog order with catalog labels', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Add builtin', created_by: user.id, builtin_sections: ['identity', 'goals-and-priorities'] })

    const res = await $fetch<{ key: string, title: string, is_custom: boolean }>(
      `/api/context/portfolios/${p.slug}/sections`,
      { method: 'POST', body: { key: 'team' }, ...opts }
    )
    expect(res).toMatchObject({ key: 'team', title: 'Team', is_custom: false })

    const keys = (await listSections(p.slug, opts)).map(s => s.key)
    expect(keys).toEqual(['identity', 'team', 'goals-and-priorities'])

    const rows = await sql<{ title: string | null, created_by: string | null }[]>`
      SELECT title, created_by FROM context_section_definitions WHERE portfolio_id = ${p.id} AND key = 'team'
    `
    expect(rows[0]).toEqual({ title: null, created_by: user.id })
  })

  it('rejects adding a built-in that is already present with 409', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Present', created_by: user.id })

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST',
      body: { key: 'identity' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('rejects a key that is not in the catalog with 400', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Unknown key', created_by: user.id })

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST',
      body: { key: 'roadmap' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('member without context.section.custom gets 403', async () => {
    const { org, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Perm', created_by: user.id, builtin_sections: [] })
    const m = await addContextMember(sql, org.id, ['member'])

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST',
      body: { key: 'identity' },
      ...withOrgHeader(m.auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})

describe('PATCH /api/context/portfolios/:slug/sections/:key', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('renames a custom section; key and content stay', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Rename', created_by: user.id, builtin_sections: [] })
    await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST', body: { title: 'Project Clarification and Pitch Methodology' }, ...opts
    })
    const key = 'project-clarification-and-pitch-methodology'
    await seedTestSection(sql, { portfolio_id: p.id, section_key: key, content: 'kept' })

    const res = await $fetch<{ key: string, title: string, description: string }>(
      `/api/context/portfolios/${p.slug}/sections/${key}`,
      { method: 'PATCH', body: { title: 'Project Clarification', description: 'Scope' }, ...opts }
    )
    expect(res).toMatchObject({ key, title: 'Project Clarification', description: 'Scope' })

    const list = await listSections(p.slug, opts)
    expect(list.find(s => s.key === key)).toMatchObject({ title: 'Project Clarification', has_content: true })
  })

  it('member without context.section.custom gets 403', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Rename perm', created_by: user.id, builtin_sections: [] })
    await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST', body: { title: 'Roadmap' }, ...withOrgHeader(auth, org.slug)
    })
    const m = await addContextMember(sql, org.id, ['member'])

    const err = await $fetch(`/api/context/portfolios/${p.slug}/sections/roadmap`, {
      method: 'PATCH',
      body: { title: 'Plan' },
      ...withOrgHeader(m.auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})

describe('DELETE /api/context/portfolios/:slug/sections/:key', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('removes a built-in from the list and its key stops resolving', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Delete builtin', created_by: user.id })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'identity', content: 'We make widgets.', last_edited_by: user.id })

    const res = await $fetch<{ ok: boolean, key: string, is_custom: boolean, content_retained: boolean }>(
      `/api/context/portfolios/${p.slug}/sections/identity`,
      { method: 'DELETE', ...opts }
    )
    expect(res).toMatchObject({ ok: true, key: 'identity', is_custom: false, content_retained: true })

    const keys = (await listSections(p.slug, opts)).map(s => s.key)
    expect(keys).toHaveLength(CONTEXT_SECTIONS.length - 1)
    expect(keys).not.toContain('identity')

    for (const call of [
      $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, { ...opts }),
      $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, { method: 'PUT', body: { content: 'x' }, ...opts }),
      $fetch(`/api/context/portfolios/${p.slug}/sections/identity/export`, { ...opts }),
      $fetch(`/api/context/portfolios/${p.slug}/sections/identity/versions`, { ...opts }),
      $fetch(`/api/context/portfolios/${p.slug}/sections/identity/comments`, { ...opts }),
      $fetch(`/api/context/portfolios/${p.slug}/sections/identity/comments`, {
        method: 'POST',
        body: { content: 'hi', quoted_text: 'We', anchor_start: 0, anchor_end: 2 },
        ...opts
      })
    ]) {
      const err = await call.catch(e => e)
      expect(err.statusCode).toBe(404)
    }

    const buf = await $fetch<ArrayBuffer>(`/api/context/portfolios/${p.slug}/export`, { responseType: 'arrayBuffer', ...opts })
    const zip = await JSZip.loadAsync(Buffer.from(buf))
    expect(zip.file('identity.md')).toBeNull()
    expect(zip.file('team.md')).toBeTruthy()
  })

  it('keeps content and history across delete and re-add', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Round trip', created_by: user.id })
    await $fetch(`/api/context/portfolios/${p.slug}/sections/team`, { method: 'PUT', body: { content: 'Alice, Bob' }, ...opts })
    await $fetch(`/api/context/portfolios/${p.slug}/sections/team`, { method: 'PUT', body: { content: 'Alice, Bob, Cy' }, ...opts })

    await $fetch(`/api/context/portfolios/${p.slug}/sections/team`, { method: 'DELETE', ...opts })
    await $fetch(`/api/context/portfolios/${p.slug}/sections`, { method: 'POST', body: { key: 'team' }, ...opts })

    const section = await $fetch<{ content: string }>(`/api/context/portfolios/${p.slug}/sections/team`, { ...opts })
    expect(section.content).toBe('Alice, Bob, Cy')
    const versions = await $fetch<{ versions: unknown[] }>(`/api/context/portfolios/${p.slug}/sections/team/versions`, { ...opts })
    expect(versions.versions).toHaveLength(2)
  })

  it('deletes a custom section by key', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Delete custom', created_by: user.id })
    await $fetch(`/api/context/portfolios/${p.slug}/sections`, { method: 'POST', body: { title: 'Roadmap' }, ...opts })

    const res = await $fetch<{ is_custom: boolean, content_retained: boolean }>(
      `/api/context/portfolios/${p.slug}/sections/roadmap`,
      { method: 'DELETE', ...opts }
    )
    expect(res).toMatchObject({ is_custom: true, content_retained: false })
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM context_section_definitions WHERE portfolio_id = ${p.id} AND key = 'roadmap'
    `
    expect(rows).toHaveLength(0)
  })

  it('unknown key → 404; member without context.section.custom → 403', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Errors', created_by: user.id })
    const m = await addContextMember(sql, org.id, ['member'])

    const notFound = await $fetch(`/api/context/portfolios/${p.slug}/sections/nope`, {
      method: 'DELETE', ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(notFound.statusCode).toBe(404)

    const forbidden = await $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, {
      method: 'DELETE', ...withOrgHeader(m.auth, org.slug)
    }).catch(e => e)
    expect(forbidden.statusCode).toBe(403)
  })

  it('logs the add and the delete against the definition row', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Audit', created_by: user.id, builtin_sections: [] })

    const added = await $fetch<{ id: string }>(`/api/context/portfolios/${p.slug}/sections`, { method: 'POST', body: { key: 'identity' }, ...opts })
    await $fetch(`/api/context/portfolios/${p.slug}/sections/identity`, { method: 'DELETE', ...opts })

    await new Promise(r => setTimeout(r, 200))
    const rows = await sql<{ event_type: string }[]>`
      SELECT event_type FROM activity_logs
      WHERE user_id = ${user.id} AND table_name = 'context_section_definitions' AND record_id = ${added.id}
      ORDER BY "timestamp" ASC
    `
    expect(rows.map(r => r.event_type)).toEqual(['CREATE', 'DELETE'])
  })
})
