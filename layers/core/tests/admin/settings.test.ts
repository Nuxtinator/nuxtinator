import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createAndLoginUser,
  createOperatorAdmin,
  createPendingInvite
} from '../helpers'

describe('/api/admin/settings', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await sql`DELETE FROM core_host_settings WHERE namespace = 'core' AND key = 'self_registration'`
    await cleanupCoreTestData(sql)
  })

  it('is operator-admin only', async () => {
    const { auth } = await createAndLoginUser(sql)
    const get = await $fetch('/api/admin/settings', auth).catch(e => e)
    expect(get.statusCode).toBe(403)
    const put = await $fetch('/api/admin/settings', { method: 'PUT', body: { selfRegistration: false }, ...auth }).catch(e => e)
    expect(put.statusCode).toBe(403)
  })

  it('closing self-registration blocks /register but not invites, and reopening drops the override', async () => {
    const { auth } = await createOperatorAdmin(sql)
    expect(await $fetch('/api/admin/settings', auth)).toEqual({ selfRegistration: true })

    await $fetch('/api/admin/settings', { method: 'PUT', body: { selfRegistration: false }, ...auth })
    try {
      expect(await $fetch('/api/admin/settings', auth)).toEqual({ selfRegistration: false })
      expect(await $fetch('/api/auth/registration')).toEqual({ open: false })

      const err = await $fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'x-forwarded-for': `test-${randomUUID()}` },
        body: { email: `test-core-closed-${randomUUID().slice(0, 8)}@example.com`, password: 'testpassword123', display_name: 'Closed' }
      }).catch(e => e)
      expect(err.statusCode).toBe(403)

      const invite = await createPendingInvite(sql)
      const accepted = await $fetch('/api/auth/accept-invite', {
        method: 'POST',
        body: { token: invite.token, password: 'password123', display_name: 'Invited' }
      })
      expect(accepted.success).toBe(true)
    } finally {
      await $fetch('/api/admin/settings', { method: 'PUT', body: { selfRegistration: true }, ...auth })
    }

    const rows = await sql`SELECT 1 FROM core_host_settings WHERE namespace = 'core' AND key = 'self_registration'`
    expect(rows.length).toBe(0)
    expect(await $fetch('/api/auth/registration')).toEqual({ open: true })
  })

  it('rejects a non-boolean value', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const err = await $fetch('/api/admin/settings', { method: 'PUT', body: { selfRegistration: 'no' }, ...auth }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })
})
