// Apps that require other apps (`registerApp({ requires })`): while an app
// is on for an org, the apps it requires are on too and can't be turned off
// there. Views requires Records in the dev host.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin,
  withOrgHeader
} from '../helpers'

interface OrgApp { appId: string, enabled: boolean, requiredBy: string[] }

describe('required apps', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupTenancyTestData(sql) })

  it('stay on while an app that requires them is on, and refuse to be turned off', async () => {
    const { user, auth } = await createOperatorAdmin(sql)
    const slug = `test-tenancy-${randomUUID().slice(0, 8)}`
    const org = await $fetch<{ id: string }>('/api/admin/orgs', {
      method: 'POST',
      body: { name: 'Requires Org', slug, initialAdminUserId: user.id },
      ...auth
    })
    const opts = withOrgHeader(auth, slug)
    const app = async (id: string) =>
      (await $fetch<{ apps: OrgApp[] }>(`/api/o/${slug}/apps`, opts)).apps.find(a => a.appId === id)!

    // The org's own switch for Records says off; Views keeps it on.
    await sql`
      INSERT INTO org_apps (org_id, app_id, enabled, source) VALUES (${org.id}, 'records', false, 'org_admin')
      ON CONFLICT (org_id, app_id) DO UPDATE SET enabled = false`
    expect(await app('views')).toMatchObject({ enabled: true })
    expect(await app('records')).toMatchObject({ enabled: true, requiredBy: ['Views'] })

    const refused = await $fetch(`/api/o/${slug}/apps/records/disable`, { method: 'POST', ...opts }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data.statusMessage).toContain('required by Views')
    const hostRefused = await $fetch(`/api/admin/orgs/${org.id}/apps/records/disable`, { method: 'POST', ...auth }).catch(e => e)
    expect(hostRefused.statusCode).toBe(409)

    // With Views off, the org's own switch decides again.
    await $fetch(`/api/o/${slug}/apps/views/disable`, { method: 'POST', ...opts })
    expect(await app('records')).toMatchObject({ enabled: false, requiredBy: [] })
  })
})
