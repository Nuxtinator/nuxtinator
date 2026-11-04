// Org-side app enable/disable. Marks org_apps row with source='org_admin' so
// the host UI can distinguish org-driven from host-set state.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
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

describe('POST /api/o/[orgSlug]/apps/[appId]/{enable,disable} (org-admin)', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('admin can disable an app for their own org → row source=org_admin', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    await $fetch(`/api/o/${org.slug}/apps/${APP_ID}/disable`, { method: 'POST', ...withOrgHeader(auth, org.slug) })

    const rows = await sql<{ enabled: boolean, source: string }[]>`
      SELECT enabled, source FROM org_apps WHERE org_id = ${org.id} AND app_id = ${APP_ID}
    `
    expect(rows[0]!.enabled).toBe(false)
    expect(rows[0]!.source).toBe('org_admin')
  })

  it('admin can re-enable after a disable', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    await $fetch(`/api/o/${org.slug}/apps/${APP_ID}/disable`, { method: 'POST', ...withOrgHeader(auth, org.slug) })
    await $fetch(`/api/o/${org.slug}/apps/${APP_ID}/enable`, { method: 'POST', ...withOrgHeader(auth, org.slug) })

    const rows = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM org_apps WHERE org_id = ${org.id} AND app_id = ${APP_ID}
    `
    expect(rows[0]!.enabled).toBe(true)
  })

  it('non-admin gets 403 (lacks org.apps.manage)', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: ['member'] })

    const err = await $fetch(`/api/o/${org.slug}/apps/${APP_ID}/disable`, {
      method: 'POST',
      ...withOrgHeader(getAuthHeaders(member), org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })

  it('returns 404 when appId is not in the catalog', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const err = await $fetch(`/api/o/${org.slug}/apps/no-such-app/disable`, {
      method: 'POST',
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})
