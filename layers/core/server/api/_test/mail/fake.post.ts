// Test-only control of the fake mail provider and DNS (MAIL_FAKE_PROVIDER=1).
import { mailFakeState, requireMailFakeProvider } from '#core/server/utils/mail-host'

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
  for (const r of body.dns ?? []) {
    mailFakeState.dns?.records.set(r.name.toLowerCase(), { txt: r.txt, mx: r.mx, cname: r.cname })
  }
  return { ok: true }
})
