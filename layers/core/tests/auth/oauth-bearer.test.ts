// OAuth access tokens on the personal-app handlers, through the test notes
// app the core test build mounts (`withUserPermission` on
// `test-core-notes.read`).
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  cleanupTestOauthClients,
  createAndLoginUser,
  createTestOauthToken,
  bearer
} from '../helpers'

describe('OAuth bearer tokens on personal-app routes', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTestOauthClients(sql)
    await cleanupCoreTestData(sql)
  })

  async function createNote(ownerId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`INSERT INTO test_core_notes (owner_id, title) VALUES (${ownerId}, 'test-core note') RETURNING id`
    return row!.id
  }

  it('signs the token in as its user', async () => {
    const { user } = await createAndLoginUser(sql)
    const noteId = await createNote(user.id)
    const { token } = await createTestOauthToken(sql, user, ['test-core-notes.read'])

    const note = await $fetch<{ id: string }>(`/api/test-core-notes/${noteId}`, bearer(token))
    expect(note.id).toBe(noteId)
  })

  it('refuses a token without the route permission as a scope', async () => {
    const { user } = await createAndLoginUser(sql)
    const noteId = await createNote(user.id)
    const { token } = await createTestOauthToken(sql, user, ['offline_access'])

    const res = await fetch(`/api/test-core-notes/${noteId}`, bearer(token))
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  it('rejects an unknown token with 401 even alongside a valid session cookie', async () => {
    const { user, auth } = await createAndLoginUser(sql)
    const noteId = await createNote(user.id)

    const res = await fetch(`/api/test-core-notes/${noteId}`, {
      headers: { ...auth.headers, authorization: 'Bearer not-a-real-token' }
    })
    expect(res.status).toBe(401)
  })

  it('acts as the token user, not the session user sent with it', async () => {
    const owner = await createAndLoginUser(sql)
    const other = await createAndLoginUser(sql)
    const noteId = await createNote(owner.user.id)
    const { token } = await createTestOauthToken(sql, other.user, ['test-core-notes.read'])

    const res = await fetch(`/api/test-core-notes/${noteId}`, {
      headers: { ...owner.auth.headers, authorization: `Bearer ${token}` }
    })
    expect(res.status).toBe(404)
  })

  it('refuses a revoked token', async () => {
    const { user } = await createAndLoginUser(sql)
    const noteId = await createNote(user.id)
    const { token, familyId } = await createTestOauthToken(sql, user, ['test-core-notes.read'])
    await sql`UPDATE oauth_token_families SET revoked = true WHERE family_id = ${familyId}`

    const res = await fetch(`/api/test-core-notes/${noteId}`, bearer(token))
    expect(res.status).toBe(401)
  })

  it('keeps the session path working', async () => {
    const { user, auth } = await createAndLoginUser(sql)
    const noteId = await createNote(user.id)

    const note = await $fetch<{ id: string }>(`/api/test-core-notes/${noteId}`, auth)
    expect(note.id).toBe(noteId)
  })
})
