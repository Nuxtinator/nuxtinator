// Test-only control of the fake mail provider and DNS (MAIL_FAKE_PROVIDER=1).
import type { DomainInspection, MailAlert } from '@nuxtinator/mail/kernel'
import { mailFakeState, notifyMailAlert, requireMailFakeProvider } from '#core/server/utils/mail-host'

export default defineEventHandler(async (event) => {
  const fake = requireMailFakeProvider(event)
  const body = await readBody(event) as {
    reset?: boolean
    capabilities?: Record<string, boolean>
    mode?: 'disabled' | 'mirrored' | 'unmanaged' | null
    domainStatus?: 'pending' | 'verified' | 'failed'
    nextResults?: never[]
    deliver?: boolean
    dns?: { name: string, txt?: string[], mx?: { exchange: string, priority: number }[], cname?: string[] }[]
    alert?: MailAlert
    inspection?: DomainInspection
    adminKey?: boolean
  }
  if (body.reset) {
    fake.reset()
    mailFakeState.dns?.records.clear()
  }
  if (body.capabilities) fake.control.capabilities = body.capabilities
  if (body.mode !== undefined) fake.control.mode = body.mode
  if (body.domainStatus) fake.control.domainStatus = body.domainStatus
  if (body.nextResults) fake.control.nextResults.push(...body.nextResults)
  if (body.deliver !== undefined) fake.control.deliver = body.deliver
  if (body.inspection) fake.control.inspection = body.inspection
  if (body.adminKey !== undefined) fake.control.adminKey = body.adminKey
  for (const r of body.dns ?? []) {
    mailFakeState.dns?.records.set(r.name.toLowerCase(), { txt: r.txt, mx: r.mx, cname: r.cname })
  }
  if (body.alert) await notifyMailAlert(body.alert)
  return { ok: true }
})
