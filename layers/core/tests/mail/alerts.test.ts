// notifyMailAlert with its database and mail modules stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest'

const ctl = vi.hoisted(() => ({
  sender: null as { domain: string } | null,
  sent: [] as { to: string, subject: string }[]
}))

vi.mock('../../server/utils/database', () => {
  const chain = { select: () => chain, where: () => chain, execute: async () => [{ email: 'host-admin@alerts.test' }] }
  return { db: { selectFrom: () => chain } }
})
vi.mock('../../server/utils/mail', () => ({
  useMail: async () => ({ resolveSender: async () => ctl.sender }),
  sendMail: async (m: { to: string, subject: string }) => {
    ctl.sent.push({ to: m.to, subject: m.subject })
    return { status: 'queued', outboxId: 'x' }
  }
}))
vi.mock('../../server/utils/site-url', () => ({ getSiteUrl: () => 'http://alerts.test' }))
vi.mock('../../server/utils/settings-store', () => ({ getHostSetting: async () => null }))

const { notifyMailAlert } = await import('../../server/utils/mail-host')

afterEach(() => {
  vi.restoreAllMocks()
  ctl.sent.length = 0
})

describe('mail alerts', () => {
  it('logs clearly when no domain can send the alert, and still queues it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctl.sender = null
    await notifyMailAlert({ kind: 'role_lost', orgId: null, domain: 'gone.test', role: 'send' })
    expect(errors.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining('has no sending domain')])
    expect(ctl.sent).toEqual([{ to: 'host-admin@alerts.test', subject: 'gone.test can no longer send mail' }])

    errors.mockClear()
    ctl.sender = { domain: 'mg.alerts.test' }
    await notifyMailAlert({ kind: 'role_lost', orgId: null, domain: 'gone.test', role: 'send' })
    expect(errors).not.toHaveBeenCalled()
  })
})
