// Host-admin per-org app enable / disable. Marks the org_apps row with
// source='host' so both admin UIs can show who set it.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin,
  createTenancyUser,
  createTestOrg
} from '../helpers'

// Pick an app id that exists in the apps catalog (seed-apps-catalog plugin
// runs at boot). 'messages' is one of the bundled apps.
const APP_ID = 'messages'

describe('host-admin /api/admin/orgs/[orgId]/apps/[appId]/{enable,disable}', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('enable creates an org_apps row with source=host, enabled=true', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)

    await $fetch(`/api/admin/orgs/${org.id}/apps/${APP_ID}/enable`, { method: 'POST', ...auth })

    const rows = await sql<{ enabled: boolean, source: string }[]>`
      SELECT enabled, source FROM org_apps WHERE org_id = ${org.id} AND app_id = ${APP_ID}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.enabled).toBe(true)
    expect(rows[0]!.source).toBe('host')
  })

  it('disable updates the row to enabled=false, source=host', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)

    await $fetch(`/api/admin/orgs/${org.id}/apps/${APP_ID}/disable`, { method: 'POST', ...auth })

    const rows = await sql<{ enabled: boolean, source: string }[]>`
      SELECT enabled, source FROM org_apps WHERE org_id = ${org.id} AND app_id = ${APP_ID}
    `
    expect(rows[0]!.enabled).toBe(false)
    expect(rows[0]!.source).toBe('host')
  })

  it('enable then disable correctly upserts (one row, latest state wins)', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)

    await $fetch(`/api/admin/orgs/${org.id}/apps/${APP_ID}/enable`, { method: 'POST', ...auth })
    await $fetch(`/api/admin/orgs/${org.id}/apps/${APP_ID}/disable`, { method: 'POST', ...auth })

    const rows = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM org_apps WHERE org_id = ${org.id} AND app_id = ${APP_ID}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.enabled).toBe(false)
  })

  it('enable returns 404 when the app id is not in the catalog', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)

    const err = await $fetch(`/api/admin/orgs/${org.id}/apps/no-such-app/enable`, { method: 'POST', ...auth }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('non-operator-admin gets 403', async () => {
    const user = await createTenancyUser(sql)
    const org = await createTestOrg(sql)
    const { getAuthHeaders } = await import('../helpers')

    const err = await $fetch(`/api/admin/orgs/${org.id}/apps/${APP_ID}/enable`, {
      method: 'POST',
      ...getAuthHeaders(user)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })

  it('unknown orgId returns 404 (middleware short-circuits before the handler upserts)', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const ghostOrg = randomUUID()

    const err = await $fetch(`/api/admin/orgs/${ghostOrg}/apps/${APP_ID}/enable`, { method: 'POST', ...auth }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})
