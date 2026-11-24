// An org's arrangement of its apps: saved by org.apps.manage holders, read back
// in the app feeds, and kept to the org that saved it.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOrgWithAdmin,
  createTenancyUser,
  addTestMembership,
  withOrgHeader,
  getAuthHeaders
} from '../helpers'

interface Layout { categories: string[], titles: Record<string, string>, custom: string[], apps: Record<string, string[]> }

describe('/api/o/[orgSlug]/app-layout', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })

  const layoutOf = async (auth: { headers: { cookie: string } }, slug: string) =>
    (await $fetch<{ layout: Layout }>(`/api/o/${slug}/_apps`, withOrgHeader(auth, slug))).layout

  it('saves the org\'s arrangement, keeps it to that org, and resets it', async () => {
    const a = await createOrgWithAdmin(sql)
    const b = await createOrgWithAdmin(sql)

    const { layout } = await $fetch<{ layout: Layout }>(`/api/o/${a.org.slug}/app-layout`, {
      method: 'PUT',
      body: {
        categories: ['tools', 'gone'],
        titles: { work: 'Projects', 'c-dev': 'Dev' },
        custom: ['c-dev', 'work'],
        apps: { 'c-dev': ['files'], gone: ['crm'] }
      },
      ...withOrgHeader(a.auth, a.org.slug)
    })
    // Unknown categories are dropped; a custom id can't shadow a built-in one.
    const saved = { categories: ['tools'], titles: { 'work': 'Projects', 'c-dev': 'Dev' }, custom: ['c-dev'], apps: { 'c-dev': ['files'] } }
    expect(layout).toEqual(saved)
    expect(await layoutOf(a.auth, a.org.slug)).toEqual(saved)

    const settings = await $fetch<{ layout: Layout, categories: { id: string }[] }>(`/api/o/${a.org.slug}/apps`, withOrgHeader(a.auth, a.org.slug))
    expect(settings.layout).toEqual(saved)
    expect(settings.categories.map(c => c.id)).toEqual(['people', 'work', 'tools', 'more'])

    expect(await layoutOf(b.auth, b.org.slug)).toEqual({ categories: [], titles: {}, custom: [], apps: {} })

    await $fetch(`/api/o/${a.org.slug}/app-layout`, { method: 'DELETE', ...withOrgHeader(a.auth, a.org.slug) })
    expect(await layoutOf(a.auth, a.org.slug)).toEqual({ categories: [], titles: {}, custom: [], apps: {} })
  })

  it('refuses members without org.apps.manage', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: [] })

    await expect($fetch(`/api/o/${org.slug}/app-layout`, {
      method: 'PUT',
      body: { categories: ['tools'] },
      ...withOrgHeader(getAuthHeaders(member), org.slug)
    })).rejects.toMatchObject({ statusCode: 403 })
  })
})
