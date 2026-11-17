// `#email` on the mail kernel: templates pick a stream, and mail goes through
// the env account (the fake provider) to Mailpit.
import { describe, it, expect, afterAll } from 'vitest'
import { getHostAdminDb } from '../helpers'
import { api, cleanupCoreMailData, createMailUser, envDomain, mailpitFrom, MAIL_ENV, sentTo, testAddress } from './helpers'

describe('#email through the mail kernel', () => {
  const sql = getHostAdminDb()

  afterAll(async () => {
    await cleanupCoreMailData(sql)
  })

  it('a password reset reaches Mailpit on the account stream, From the SMTP_FROM local part at the env domain', async () => {
    const { user } = await createMailUser(sql)
    await api('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } })

    const [sent] = await sentTo(user.email)
    expect(sent?.correlation.stream).toBe('account')
    const env = await envDomain(sql)
    const local = MAIL_ENV.SMTP_FROM.slice(0, MAIL_ENV.SMTP_FROM.lastIndexOf('@'))
    const expected = `${local}@${env.from_domain ?? env.domain}`
    expect(env.domain).toBe(MAIL_ENV.MAIL_DOMAIN)
    expect(sent!.from.address).toBe(expected)
    expect(sent!.domain).toBe(MAIL_ENV.MAIL_DOMAIN)
    expect((await mailpitFrom(user.email)).Address).toBe(expected)
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
