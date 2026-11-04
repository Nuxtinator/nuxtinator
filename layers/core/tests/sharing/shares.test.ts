// Sharing a personal item, through the test notes app the core test build
// mounts (tests/fixtures/notes-*). Its tables come from core's share-table
// helper.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createAndLoginUser
} from '../helpers'

type Auth = Awaited<ReturnType<typeof createAndLoginUser>>['auth']

interface ShareState {
  canManage: boolean
  owner: { id: string } | null
  shares: { id: string, role: string, user: { id: string } | null, pending: { email: string | null, expired: boolean } | null }[]
}

const tokenOf = (url: string) => new URL(url).searchParams.get('token')!

describe('sharing a personal item', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await sql`DELETE FROM core_host_settings WHERE namespace = 'core' AND key = 'self_registration'`
    await sql`DELETE FROM invites WHERE kind = 'share' AND invited_by IN (SELECT id FROM users WHERE email LIKE 'test-core-%@example.com')`
    await sql`DELETE FROM activity_logs WHERE event_type = 'SHARE_INVITE_EMAIL'`
    await cleanupCoreTestData(sql)
  })

  async function createNote(ownerId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`INSERT INTO test_core_notes (owner_id, title) VALUES (${ownerId}, 'test-core note') RETURNING id`
    return row!.id
  }

  async function shareByLink(noteId: string, auth: Auth, role = 'viewer'): Promise<string> {
    const res = await $fetch<{ url: string }>(`/api/test-core-notes/${noteId}/shares`, { method: 'POST', body: { link: true, role }, ...auth })
    return tokenOf(res.url)
  }

  async function accept(token: string, auth: Auth) {
    return await $fetch('/api/auth/accept-invite', { method: 'POST', body: { token }, ...auth })
  }

  it('a link share reaches the person who accepts it, and makes them known people', async () => {
    const { user: owner, auth: ownerAuth } = await createAndLoginUser(sql)
    const { user: friend, auth: friendAuth } = await createAndLoginUser(sql)
    const noteId = await createNote(owner.id)

    expect((await $fetch(`/api/test-core-notes/${noteId}`, friendAuth).catch(e => e)).statusCode).toBe(404)

    const token = await shareByLink(noteId, ownerAuth, 'editor')
    expect((await $fetch(`/api/test-core-notes/${noteId}`, friendAuth).catch(e => e)).statusCode).toBe(404)

    await accept(token, friendAuth)
    expect(await $fetch(`/api/test-core-notes/${noteId}`, friendAuth)).toMatchObject({ id: noteId })

    const asFriend = await $fetch<ShareState>(`/api/test-core-notes/${noteId}/shares`, friendAuth)
    expect(asFriend.canManage).toBe(false)
    expect(asFriend.owner?.id).toBe(owner.id)
    expect(asFriend.shares).toEqual([expect.objectContaining({ role: 'editor', user: expect.objectContaining({ id: friend.id }), pending: null })])

    const ownerPeople = await $fetch<{ people: { id: string }[] }>('/api/shares/people', ownerAuth)
    expect(ownerPeople.people.map(p => p.id)).toEqual([friend.id])
    const friendPeople = await $fetch<{ people: { id: string }[] }>('/api/shares/people', friendAuth)
    expect(friendPeople.people.map(p => p.id)).toEqual([owner.id])
  })

  it('shares directly only with known people', async () => {
    const { user: owner, auth: ownerAuth } = await createAndLoginUser(sql)
    const { user: friend, auth: friendAuth } = await createAndLoginUser(sql)
    const { user: stranger } = await createAndLoginUser(sql)
    const first = await createNote(owner.id)
    const second = await createNote(owner.id)

    const toStranger = await $fetch(`/api/test-core-notes/${second}/shares`, {
      method: 'POST', body: { userId: stranger.id, role: 'viewer' }, ...ownerAuth
    }).catch(e => e)
    expect(toStranger.statusCode).toBe(400)

    await accept(await shareByLink(first, ownerAuth), friendAuth)
    await $fetch(`/api/test-core-notes/${second}/shares`, { method: 'POST', body: { userId: friend.id, role: 'viewer' }, ...ownerAuth })
    expect(await $fetch(`/api/test-core-notes/${second}`, friendAuth)).toMatchObject({ id: second })
  })

  it('only the owner manages shares, and a grantee can leave', async () => {
    const { user: owner, auth: ownerAuth } = await createAndLoginUser(sql)
    const { auth: friendAuth } = await createAndLoginUser(sql)
    const noteId = await createNote(owner.id)
    await accept(await shareByLink(noteId, ownerAuth), friendAuth)

    const notOwner = await $fetch(`/api/test-core-notes/${noteId}/shares`, { method: 'POST', body: { link: true, role: 'viewer' }, ...friendAuth }).catch(e => e)
    expect(notOwner.statusCode).toBe(403)

    const { shares } = await $fetch<ShareState>(`/api/test-core-notes/${noteId}/shares`, friendAuth)
    const promote = await $fetch(`/api/test-core-notes/${noteId}/shares/${shares[0]!.id}`, { method: 'PATCH', body: { role: 'editor' }, ...friendAuth }).catch(e => e)
    expect(promote.statusCode).toBe(403)

    await $fetch(`/api/test-core-notes/${noteId}/shares/${shares[0]!.id}`, { method: 'DELETE', ...friendAuth })
    expect((await $fetch(`/api/test-core-notes/${noteId}`, friendAuth).catch(e => e)).statusCode).toBe(404)
  })

  it('accepting a share the person already has keeps the higher role', async () => {
    const { user: owner, auth: ownerAuth } = await createAndLoginUser(sql)
    const { user: friend, auth: friendAuth } = await createAndLoginUser(sql)
    const noteId = await createNote(owner.id)
    await accept(await shareByLink(noteId, ownerAuth, 'viewer'), friendAuth)
    await accept(await shareByLink(noteId, ownerAuth, 'editor'), friendAuth)

    const rows = await sql<{ role: string, grantee_user_id: string | null }[]>`SELECT role, grantee_user_id FROM test_core_note_shares WHERE resource_id = ${noteId}`
    expect(rows).toEqual([{ role: 'editor', grantee_user_id: friend.id }])
  })

  it('an email share is a share invite: off the admin list, resendable, revoked with its share', async () => {
    const { user: owner, auth: ownerAuth } = await createAndLoginUser(sql, { is_admin: true })
    const noteId = await createNote(owner.id)
    const email = `test-core-share-${randomUUID().slice(0, 8)}@example.com`

    await $fetch(`/api/test-core-notes/${noteId}/shares`, { method: 'POST', body: { email, role: 'viewer' }, ...ownerAuth })
    const [invite] = await sql<{ id: string, kind: string }[]>`SELECT id, kind FROM invites WHERE email = ${email}`
    expect(invite?.kind).toBe('share')

    const adminList = await $fetch<{ invites: { id: string }[] }>('/api/admin/invites', ownerAuth)
    expect(adminList.invites.map(i => i.id)).not.toContain(invite!.id)

    const { shares } = await $fetch<ShareState>(`/api/test-core-notes/${noteId}/shares`, ownerAuth)
    expect(shares).toEqual([expect.objectContaining({ user: null, pending: { email, expired: false } })])

    const resent = await $fetch<{ url: string }>(`/api/test-core-notes/${noteId}/shares/${shares[0]!.id}/resend`, { method: 'POST', ...ownerAuth })
    expect(tokenOf(resent.url)).toBeTruthy()

    await $fetch(`/api/test-core-notes/${noteId}/shares/${shares[0]!.id}`, { method: 'DELETE', ...ownerAuth })
    expect(await sql`SELECT 1 FROM invites WHERE id = ${invite!.id}`).toHaveLength(0)
  })

  it('a share invite creates an account only while self-registration is on', async () => {
    const { user: owner, auth: ownerAuth } = await createAndLoginUser(sql)
    const noteId = await createNote(owner.id)
    const email = `test-core-share-${randomUUID().slice(0, 8)}@example.com`
    const res = await $fetch<{ url: string }>(`/api/test-core-notes/${noteId}/shares`, { method: 'POST', body: { email, role: 'viewer' }, ...ownerAuth })
    const token = tokenOf(res.url)

    await sql`INSERT INTO core_host_settings (namespace, key, value) VALUES ('core', 'self_registration', 'false'::jsonb)
      ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`
    const info = await $fetch<{ share: boolean, can_create_account: boolean }>('/api/auth/invite-info', { query: { token } })
    expect(info).toMatchObject({ share: true, can_create_account: false })

    const closed = await $fetch('/api/auth/accept-invite', {
      method: 'POST', body: { token, password: 'password123', display_name: 'Shared With' }
    }).catch(e => e)
    expect(closed.statusCode).toBe(403)
    expect(closed.data?.data?.code).toBe('registration_closed')

    await sql`DELETE FROM core_host_settings WHERE namespace = 'core' AND key = 'self_registration'`
    await $fetch('/api/auth/accept-invite', { method: 'POST', body: { token, password: 'password123', display_name: 'Shared With' } })
    const [created] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`
    const rows = await sql<{ grantee_user_id: string }[]>`SELECT grantee_user_id FROM test_core_note_shares WHERE resource_id = ${noteId}`
    expect(rows.map(r => r.grantee_user_id)).toEqual([created!.id])
  })
})
