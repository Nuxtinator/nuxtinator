import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createPendingInvite,
  createAndLoginUser,
  createTestUser
} from '../helpers'

describe('POST /api/auth/accept-invite', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('returns 400 when token is missing', async () => {
    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { password: 'password123', display_name: 'No Token' }
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 400 when password is too short', async () => {
    const invite = await createPendingInvite(sql)
    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token, password: 'short', display_name: 'Short PW' }
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
    expect(String(err.statusMessage)).toMatch(/8 characters/i)
  })

  it('returns 400 when display_name is too short', async () => {
    const invite = await createPendingInvite(sql)
    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token, password: 'password123', display_name: 'X' }
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 404 for an unknown token', async () => {
    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: randomUUID(), password: 'password123', display_name: 'Ghost' }
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('returns 410 when invite is expired', async () => {
    const invite = await createPendingInvite(sql, { expiresInMs: -1000 })
    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token, password: 'password123', display_name: 'Expired' }
    }).catch(e => e)
    expect(err.statusCode).toBe(410)
  })

  it('email invite: creates a verified account at the invited address and signs it in', async () => {
    const invite = await createPendingInvite(sql)

    const res = await fetch('/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.token, password: 'newpassword123', display_name: 'Accepted Name' })
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
    expect(data.redirect).toBe('/orgs')

    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toMatch(/auth-token=/)
    expect(setCookie).toMatch(/auth-refresh=/)

    const rows = await sql<{ id: string, verified: boolean, password: string | null, display_name: string }[]>`
      SELECT id, verified, password, display_name FROM users WHERE email = ${invite.email}`
    expect(rows.length).toBe(1)
    expect(rows[0]!.verified).toBe(true)
    expect(rows[0]!.display_name).toBe('Accepted Name')
    expect(await bcrypt.compare('newpassword123', rows[0]!.password!)).toBe(true)

    const inv = await sql<{ accepted_by: string | null }[]>`SELECT accepted_by FROM invites WHERE id = ${invite.inviteId}`
    expect(inv[0]!.accepted_by).toBe(rows[0]!.id)
  })

  it('a second accept of the same invite returns 410', async () => {
    const invite = await createPendingInvite(sql)

    await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token, password: 'password123', display_name: 'First' }
    })

    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token, password: 'password123', display_name: 'Second' }
    }).catch(e => e)
    expect(err.statusCode).toBe(410)
  })

  it('email invite: returns 409 when an account already uses the invited address', async () => {
    const user = await createTestUser(sql)
    const invite = await createPendingInvite(sql, { email: user.email })
    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token, password: 'password123', display_name: 'Dupe' }
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('link invite: requires an email', async () => {
    const invite = await createPendingInvite(sql, { email: null, display_name: 'test-core-link' })
    const err = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token, password: 'password123', display_name: 'Linky' }
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('link invite: creates an unverified account that must verify its email', async () => {
    // Another account exists, so this one isn't promoted as the first user.
    await createTestUser(sql)
    const invite = await createPendingInvite(sql, { email: null, display_name: 'test-core-link' })
    const email = `test-core-link-${randomUUID().slice(0, 8)}@example.com`

    const res = await fetch('/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.token, email, password: 'password123', display_name: 'Linky' })
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.requiresVerification).toBe(true)
    expect(res.headers.get('set-cookie') || '').not.toMatch(/auth-token=[^;]+/)

    const rows = await sql<{ verified: boolean }[]>`SELECT verified FROM users WHERE email = ${email}`
    expect(rows[0]!.verified).toBe(false)
  })

  it('signed in: accepts the invite into the current account, whatever its email', async () => {
    const { user, auth } = await createAndLoginUser(sql)
    const invite = await createPendingInvite(sql)

    const res = await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.token },
      ...auth
    })
    expect(res.success).toBe(true)

    const inv = await sql<{ accepted_by: string | null }[]>`SELECT accepted_by FROM invites WHERE id = ${invite.inviteId}`
    expect(inv[0]!.accepted_by).toBe(user.id)
    const created = await sql`SELECT 1 FROM users WHERE email = ${invite.email}`
    expect(created.length).toBe(0)
  })
})
