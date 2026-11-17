// A share to a suppressed address is still made; the sharer is told the email
// was skipped and why, and no email is sent.
import { describe, it, expect, afterEach } from 'vitest'
import { getHostAdminDb } from '../helpers'
import { api, cleanupCoreMailData, createMailUser, sentTo, suppress, testAddress } from './helpers'

describe('share invites to a suppressed address', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreMailData(sql)
  })

  async function note(ownerId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`INSERT INTO test_core_mail_notes (owner_id, title) VALUES (${ownerId}, 'test-core-mail note') RETURNING id`
    return row!.id
  }

  it.each(['hard_bounce', 'complaint'] as const)('%s: the share is created, emailed is false with the reason, nothing is sent', async (reason) => {
    const { user, auth } = await createMailUser(sql)
    const noteId = await note(user.id)
    const email = testAddress('share')
    await suppress(sql, email, reason)

    const res = await api<{ url: string, emailed: boolean, emailSkipped?: string }>(`/api/test-core-mail-notes/${noteId}/shares`, { method: 'POST', body: { email, role: 'viewer' }, ...auth })
    expect(res.emailed).toBe(false)
    expect(res.emailSkipped).toBe(reason)
    expect(res.url).toMatch(/token=/)
    const shares = await sql`SELECT s.id FROM test_core_mail_note_shares s JOIN invites i ON i.id = s.grantee_invite_id WHERE s.resource_id = ${noteId} AND i.email = ${email}`
    expect(shares).toHaveLength(1)
    expect(await sentTo(email)).toHaveLength(0)
  })

  it('a share to an address that isn\'t suppressed is emailed on the system stream', async () => {
    const { user, auth } = await createMailUser(sql)
    const noteId = await note(user.id)
    const email = testAddress('share')
    const res = await api<{ emailed: boolean, emailSkipped?: string }>(`/api/test-core-mail-notes/${noteId}/shares`, { method: 'POST', body: { email, role: 'viewer' }, ...auth })
    expect(res.emailed).toBe(true)
    expect(res.emailSkipped).toBeUndefined()
    expect((await sentTo(email)).map(m => m.correlation.stream)).toEqual(['system'])
  })
})
