// The page guard's app map: every installed app's path, with per-org enabled
// and per-user permitted flags.
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

const APP_ID = 'messages'

interface AppAccess { id: string, title: string, path: string, enabled: boolean, permitted: boolean }

describe('GET /api/o/[orgSlug]/_app-access', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })

  async function messagesEntry(auth: { headers: { cookie: string } }, slug: string) {
    const { apps } = await $fetch<{ apps: AppAccess[] }>(`/api/o/${slug}/_app-access`, withOrgHeader(auth, slug))
    return apps.find(a => a.id === APP_ID)
  }

  it('keeps a disabled app in the map with enabled=false', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    await $fetch(`/api/o/${org.slug}/apps/${APP_ID}/disable`, { method: 'POST', ...withOrgHeader(auth, org.slug) })

    const entry = await messagesEntry(auth, org.slug)
    expect(entry).toMatchObject({ path: '/messages', enabled: false, permitted: true })

    const { apps } = await $fetch<{ apps: { id: string }[] }>(`/api/o/${org.slug}/_apps`, withOrgHeader(auth, org.slug))
    expect(apps.some(a => a.id === APP_ID)).toBe(false)
  })

  it('reports enabled=true after the org re-enables the app', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    await $fetch(`/api/o/${org.slug}/apps/${APP_ID}/disable`, { method: 'POST', ...withOrgHeader(auth, org.slug) })
    await $fetch(`/api/o/${org.slug}/apps/${APP_ID}/enable`, { method: 'POST', ...withOrgHeader(auth, org.slug) })

    expect((await messagesEntry(auth, org.slug))?.enabled).toBe(true)
  })

  it('reports permitted=false for a member without the app permission', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: [] })

    expect((await messagesEntry(getAuthHeaders(member), org.slug))?.permitted).toBe(false)
  })
})
