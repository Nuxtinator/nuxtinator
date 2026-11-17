// Invites to an address the kernel suppresses: each of the four invite routes
// refuses with 422 and the reason, and creates or resends nothing. Mail the
// person asks for (a password reset) still goes out.
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { getHostAdminDb, createPendingInvite } from '../helpers'
import {
  addMembership, api, apiError, cleanupCoreMailData, createMailAdmin, createMailOrg, createMailUser, fakeState, sentTo,
  suppress, tenancyLoaded, testAddress
} from './helpers'

const BOUNCE = 'Mail to this address has bounced before, so the invite wasn\'t sent. A host admin can clear this under Admin → Email → Suppressions.'
const SPAM = 'This person marked our mail as spam, so the invite wasn\'t sent. A host admin can clear this under Admin → Email → Suppressions.'

describe('invites to a suppressed address', () => {
  const sql = getHostAdminDb()
  let multi = false

  beforeAll(async () => {
    multi = await tenancyLoaded(sql)
  })

  afterEach(async () => {
    await cleanupCoreMailData(sql)
  })

  async function adminInviteBody(email: string) {
    if (!multi) return { email }
    const org = await createMailOrg(sql)
    return { email, attachments: [{ orgId: org.id, roles: ['member'] }] }
  }

  async function emailInvite(email: string, orgId?: string) {
    const invite = await createPendingInvite(sql, { email })
    if (orgId) await sql`INSERT INTO invite_orgs (invite_id, org_id, roles) VALUES (${invite.inviteId}, ${orgId}, ${['member']})`
    const [row] = await sql<{ token_hash: string, expires_at: Date }[]>`SELECT token_hash, expires_at FROM invites WHERE id = ${invite.inviteId}`
    return { ...invite, before: row! }
  }

  async function unchanged(inviteId: string, before: { token_hash: string, expires_at: Date }) {
    const [row] = await sql<{ token_hash: string, expires_at: Date }[]>`SELECT token_hash, expires_at FROM invites WHERE id = ${inviteId}`
    expect(row).toEqual(before)
  }

  it('host admin invite: 422 with the bounce message; no invite, no mail, nothing released', async () => {
    const { auth } = await createMailAdmin(sql)
    const email = testAddress('bounced')
    await suppress(sql, email, 'hard_bounce')
    const releasedBefore = (await fakeState()).released.length

    const err = await apiError('/api/admin/users/invite', { method: 'POST', body: await adminInviteBody(email), ...auth })
    expect(err.statusCode).toBe(422)
    expect(err.data?.message ?? err.statusMessage).toBe(BOUNCE)
    expect(err.data?.data).toEqual({ reason: 'hard_bounce' })
    expect(await sql`SELECT 1 FROM invites WHERE email = ${email}`).toHaveLength(0)
    expect(await sentTo(email)).toHaveLength(0)
    expect((await fakeState()).released.length).toBe(releasedBefore)
  })

  it('host admin invite: a complaint gets the spam wording', async () => {
    const { auth } = await createMailAdmin(sql)
    const email = testAddress('complained')
    await suppress(sql, email, 'complaint')
    const err = await apiError('/api/admin/users/invite', { method: 'POST', body: await adminInviteBody(email), ...auth })
    expect(err.statusCode).toBe(422)
    expect(err.data?.message ?? err.statusMessage).toBe(SPAM)
    expect(err.data?.data).toEqual({ reason: 'complaint' })
  })

  it('host admin resend: 422; the invite keeps its link, nothing is sent or released', async () => {
    const { auth } = await createMailAdmin(sql)
    const email = testAddress('bounced')
    const invite = await emailInvite(email)
    await suppress(sql, email, 'hard_bounce')
    const releasedBefore = (await fakeState()).released.length

    const err = await apiError(`/api/admin/invites/${invite.inviteId}/resend`, { method: 'POST', ...auth })
    expect(err.statusCode).toBe(422)
    expect(err.data?.message ?? err.statusMessage).toBe(BOUNCE)
    await unchanged(invite.inviteId, invite.before)
    expect(await sentTo(email)).toHaveLength(0)
    expect((await fakeState()).released.length).toBe(releasedBefore)
  })

  it('org invite: 422; no invite, no mail, nothing released', async (ctx) => {
    if (!multi) ctx.skip()
    const org = await createMailOrg(sql)
    const { user, auth } = await createMailUser(sql)
    await addMembership(sql, user.id, org.id, ['admin'])
    const email = testAddress('bounced')
    await suppress(sql, email, 'hard_bounce')
    const releasedBefore = (await fakeState()).released.length

    const err = await apiError(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email, roles: ['member'] },
      headers: { ...auth.headers, 'x-active-org': org.slug }
    })
    expect(err.statusCode).toBe(422)
    expect(err.data?.message ?? err.statusMessage).toBe(BOUNCE)
    expect(await sql`SELECT 1 FROM invites WHERE email = ${email}`).toHaveLength(0)
    expect(await sentTo(email)).toHaveLength(0)
    expect((await fakeState()).released.length).toBe(releasedBefore)
  })

  it('org resend: 422; the invite keeps its link, nothing is sent or released', async (ctx) => {
    if (!multi) ctx.skip()
    const org = await createMailOrg(sql)
    const { user, auth } = await createMailUser(sql)
    await addMembership(sql, user.id, org.id, ['admin'])
    const email = testAddress('bounced')
    const invite = await emailInvite(email, org.id)
    await suppress(sql, email, 'hard_bounce')
    const releasedBefore = (await fakeState()).released.length

    const err = await apiError(`/api/o/${org.slug}/invites/${invite.inviteId}/resend`, {
      method: 'POST',
      headers: { ...auth.headers, 'x-active-org': org.slug }
    })
    expect(err.statusCode).toBe(422)
    expect(err.data?.message ?? err.statusMessage).toBe(BOUNCE)
    await unchanged(invite.inviteId, invite.before)
    expect(await sentTo(email)).toHaveLength(0)
    expect((await fakeState()).released.length).toBe(releasedBefore)
  })

  it('an invite to an unsuppressed address still goes out', async () => {
    const { auth } = await createMailAdmin(sql)
    const email = testAddress('fine')
    await api('/api/admin/users/invite', { method: 'POST', body: await adminInviteBody(email), ...auth })
    expect((await sentTo(email)).map(m => m.correlation.stream)).toEqual(['system'])
  })

  it('a password reset to a hard-bounced address is sent', async () => {
    const { user } = await createMailUser(sql)
    await suppress(sql, user.email, 'hard_bounce')
    await api('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } })
    const sent = await sentTo(user.email)
    expect(sent.map(m => m.correlation.stream)).toEqual(['account'])
    const [reset] = await sql`SELECT 1 FROM password_reset_requests WHERE user_id = ${user.id}`
    expect(reset).toBeDefined()
  })
})
