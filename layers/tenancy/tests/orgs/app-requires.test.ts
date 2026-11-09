// Apps that require other apps (`registerApp({ requires })`): while an app
// is on for an org, the apps it requires are on too and can't be turned off
// there. Views requires Records in the dev host.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin,
  withOrgHeader
} from '../helpers'

interface OrgApp { appId: string, enabled: boolean, requiredBy: string[] }
interface AppOrg { id: string, enabled: boolean, requiredBy: string[] }

describe('required apps', () => {
  const sql = getHostAdminDb()
  let recordsStatus: string | null = null
  beforeAll(async () => {
    const [row] = await sql<{ status: string | null }[]>`SELECT status FROM apps WHERE id = 'records'`
    recordsStatus = row?.status ?? null
  })
  afterEach(async () => {
    await sql`UPDATE apps SET status = ${recordsStatus} WHERE id = 'records'`
    await cleanupTenancyTestData(sql)
  })

  async function createOrg(auth: { headers: { cookie: string } }, userId: string) {
    const slug = `test-tenancy-${randomUUID().slice(0, 8)}`
    const org = await $fetch<{ id: string }>('/api/admin/orgs', {
      method: 'POST',
      body: { name: 'Requires Org', slug, initialAdminUserId: userId },
      ...auth
    })
    return { id: org.id, slug }
  }

  it('stay on while an app that requires them is on, and refuse to be turned off', async () => {
    const { user, auth } = await createOperatorAdmin(sql)
    const org = await createOrg(auth, user.id)
    const slug = org.slug
    const opts = withOrgHeader(auth, slug)
    const app = async (id: string) =>
      (await $fetch<{ apps: OrgApp[] }>(`/api/o/${slug}/apps`, opts)).apps.find(a => a.appId === id)!

    // The org's own switch for Records says off; Views keeps it on.
    await sql`
      INSERT INTO org_apps (org_id, app_id, enabled, source) VALUES (${org.id}, 'records', false, 'org_admin')
      ON CONFLICT (org_id, app_id) DO UPDATE SET enabled = false`
    expect(await app('views')).toMatchObject({ enabled: true })
    expect(await app('records')).toMatchObject({ enabled: true, requiredBy: ['Views'] })
    const hostView = await $fetch<{ orgs: AppOrg[] }>('/api/admin/apps/records/orgs', auth)
    expect(hostView.orgs.find(o => o.id === org.id)).toMatchObject({ enabled: true, requiredBy: ['Views'] })

    const refused = await $fetch(`/api/o/${slug}/apps/records/disable`, { method: 'POST', ...opts }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data.statusMessage).toContain('required by Views')
    const hostRefused = await $fetch(`/api/admin/orgs/${org.id}/apps/records/disable`, { method: 'POST', ...auth }).catch(e => e)
    expect(hostRefused.statusCode).toBe(409)

    // With Views off, the org's own switch decides again.
    await $fetch(`/api/o/${slug}/apps/views/disable`, { method: 'POST', ...opts })
    expect(await app('records')).toMatchObject({ enabled: false, requiredBy: [] })
  })

  it('leave a host-controlled app as the host set it for the org', async () => {
    const { user, auth } = await createOperatorAdmin(sql)
    await sql`UPDATE apps SET status = 'host_controlled' WHERE id = 'records'`
    const org = await createOrg(auth, user.id)
    await sql`DELETE FROM org_apps WHERE org_id = ${org.id} AND app_id = 'records'`
    const apps = (await $fetch<{ apps: OrgApp[] }>(`/api/o/${org.slug}/apps`, withOrgHeader(auth, org.slug))).apps
    expect(apps.find(a => a.appId === 'views')).toMatchObject({ enabled: true })
    expect(apps.find(a => a.appId === 'records')).toBeUndefined()

    await $fetch(`/api/admin/orgs/${org.id}/apps/records/enable`, { method: 'POST', ...auth })
    await $fetch(`/api/admin/orgs/${org.id}/apps/records/disable`, { method: 'POST', ...auth })
    const hostView = await $fetch<{ orgs: AppOrg[] }>('/api/admin/apps/records/orgs', auth)
    expect(hostView.orgs.find(o => o.id === org.id)).toMatchObject({ enabled: false, requiredBy: [] })
  })
})
