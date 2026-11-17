// `#email` on the mail kernel: templates pick a stream, and mail goes through
// the env account (the fake provider) to Mailpit.
import { describe, it, expect, afterAll } from 'vitest'
import { getHostAdminDb } from '../helpers'
import { api, cleanupCoreMailData, createMailUser, fakeControl, mailpitFrom, MAIL_ENV, sentTo, testAddress } from './helpers'

describe('#email through the mail kernel', () => {
  const sql = getHostAdminDb()

  afterAll(async () => {
    await cleanupCoreMailData(sql)
  })

  it('a password reset reaches Mailpit on the account stream, From SMTP_FROM as configured', async () => {
    const { user } = await createMailUser(sql)
    await api('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } })

    const [sent] = await sentTo(user.email)
    expect(sent?.correlation.stream).toBe('account')
    expect(sent!.from.address).toBe(MAIL_ENV.SMTP_FROM)
    expect(sent!.domain).toBe(MAIL_ENV.MAIL_DOMAIN)
    expect((await mailpitFrom(user.email)).Address).toBe(MAIL_ENV.SMTP_FROM)
  })

  it('a password reset whose provider call ends with an unknown outcome keeps its reset link', async () => {
    const { user } = await createMailUser(sql)
    await fakeControl({ nextResults: [{ status: 'unknown', error: 'The provider didn\'t answer in time' }] })
    await api('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } })
    expect(await sentTo(user.email)).toHaveLength(0)
    expect(await sql`SELECT 1 FROM password_reset_requests WHERE user_id = ${user.id}`).toHaveLength(1)
  })

  it.each([
    ['passwordReset', 'account'],
    ['verification', 'account'],
    ['emailChangeVerification', 'account'],
    ['invite', 'system'],
    ['notification', 'system'],
    ['shareInvite', 'system']
  ])('%s goes on the %s stream', async (template, stream) => {
    const to = testAddress(template.toLowerCase())
    const res = await api<{ ok: boolean }>('/api/test-core-mail/send-template', { method: 'POST', body: { to, template } })
    expect(res.ok).toBe(true)
    const sent = await sentTo(to)
    expect(sent.map(m => m.correlation.stream)).toEqual([stream])
  })
})
