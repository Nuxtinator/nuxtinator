// Reordering a portfolio's sections over HTTP: the stored order wins over the
// catalog, custom and built-in sections share one position space, a list that
// doesn't cover the portfolio is rejected, and a section added afterwards
// lands at the end.
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

interface SectionMeta { key: string, title: string, is_custom: boolean, order: number }

async function listKeys(slug: string, opts: ReturnType<typeof withOrgHeader>): Promise<string[]> {
  const res = await $fetch<{ sections: SectionMeta[] }>(`/api/context/portfolios/${slug}/sections`, { ...opts })
  return res.sections.map(s => s.key)
}

function reorder(slug: string, keys: string[], opts: ReturnType<typeof withOrgHeader>) {
  return $fetch<{ sections: SectionMeta[] }>(`/api/context/portfolios/${slug}/section-order`, {
    method: 'PUT',
    body: { keys },
    ...opts
  })
}

describe('PUT /api/context/portfolios/:slug/section-order', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('stores the given order and returns sections in it', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, {
      org_id: org.id, name: 'Ordered', created_by: user.id,
      builtin_sections: ['identity', 'team', 'goals-and-priorities']
    })
    const opts = withOrgHeader(auth, org.slug)

    const res = await reorder(p.slug, ['team', 'goals-and-priorities', 'identity'], opts)
    expect(res.sections.map(s => s.key)).toEqual(['team', 'goals-and-priorities', 'identity'])
    expect(await listKeys(p.slug, opts)).toEqual(['team', 'goals-and-priorities', 'identity'])
  })

  it('lets a custom section sit between two built-ins', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, {
      org_id: org.id, name: 'Mixed', created_by: user.id, builtin_sections: ['identity', 'team']
    })
    const opts = withOrgHeader(auth, org.slug)

    await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST', body: { title: 'Roadmap' }, ...opts
    })
    await reorder(p.slug, ['identity', 'roadmap', 'team'], opts)

    expect(await listKeys(p.slug, opts)).toEqual(['identity', 'roadmap', 'team'])
  })

  it('rejects a list that omits a section, leaving the order untouched', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, {
      org_id: org.id, name: 'Partial', created_by: user.id, builtin_sections: ['identity', 'team']
    })
    const opts = withOrgHeader(auth, org.slug)

    const err = await reorder(p.slug, ['team'], opts).catch(e => e)
    expect(err.statusCode).toBe(400)
    expect(await listKeys(p.slug, opts)).toEqual(['identity', 'team'])
  })

  it('rejects a key that is not in the portfolio, and a repeated key', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, {
      org_id: org.id, name: 'Bad keys', created_by: user.id, builtin_sections: ['identity', 'team']
    })
    const opts = withOrgHeader(auth, org.slug)

    const unknown = await reorder(p.slug, ['identity', 'personas'], opts).catch(e => e)
    expect(unknown.statusCode).toBe(400)

    const dupe = await reorder(p.slug, ['identity', 'identity'], opts).catch(e => e)
    expect(dupe.statusCode).toBe(400)
  })

  it('appends a section added after a reorder to the end', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, {
      org_id: org.id, name: 'Append', created_by: user.id, builtin_sections: ['identity', 'team']
    })
    const opts = withOrgHeader(auth, org.slug)

    await reorder(p.slug, ['team', 'identity'], opts)
    await $fetch(`/api/context/portfolios/${p.slug}/sections`, {
      method: 'POST', body: { key: 'personas' }, ...opts
    })

    expect(await listKeys(p.slug, opts)).toEqual(['team', 'identity', 'personas'])
  })

  it('member without context.section.custom gets 403', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, {
      org_id: org.id, name: 'Guarded', created_by: user.id, builtin_sections: ['identity', 'team']
    })
    const member = await addContextMember(sql, org.id, ['member'])

    const err = await reorder(p.slug, ['team', 'identity'], withOrgHeader(member.auth, org.slug)).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})
