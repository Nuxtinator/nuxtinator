import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createPendingInvite
} from '../helpers'

describe('GET /api/auth/invite-info', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('returns 400 when token is missing', async () => {
    const err = await $fetch('/api/auth/invite-info').catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 404 for an unknown token', async () => {
    const err = await $fetch(`/api/auth/invite-info?token=${randomUUID()}`).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('returns 404 once the invite has been accepted', async () => {
    const invite = await createPendingInvite(sql)
    await sql`UPDATE invites SET accepted_at = now() WHERE id = ${invite.inviteId}`
    const err = await $fetch(`/api/auth/invite-info?token=${invite.token}`).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('returns 410 when token is expired', async () => {
    const invite = await createPendingInvite(sql, { expiresInMs: -1000 })
    const err = await $fetch(`/api/auth/invite-info?token=${invite.token}`).catch(e => e)
    expect(err.statusCode).toBe(410)
  })

  it('returns kind, email, display_name and (empty) orgs for an email invite', async () => {
    const invite = await createPendingInvite(sql, { display_name: 'Pending Person' })
    const res = await $fetch(`/api/auth/invite-info?token=${invite.token}`)
    expect(res.kind).toBe('email')
    expect(res.email).toBe(invite.email)
    expect(res.display_name).toBe('Pending Person')
    expect(res.orgs).toEqual([])
  })

  it('reports a link invite with no email', async () => {
    const invite = await createPendingInvite(sql, { email: null, display_name: 'test-core-link' })
    const res = await $fetch(`/api/auth/invite-info?token=${invite.token}`)
    expect(res.kind).toBe('link')
    expect(res.email).toBeNull()
  })
})
