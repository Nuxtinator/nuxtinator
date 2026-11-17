// Mail admin e2e helpers. The specs drive the fake mail provider and fake DNS,
// which exist only when the server runs with MAIL_FAKE_PROVIDER=1 and
// MAIL_TRANSPORT=provider; without them the specs skip.
import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { getHostAdminDb } from '@nuxtinator/core/test-helpers'

export const E2E_MAIL_TLD = 'e2email.test'
export const E2E_MAIL_LABEL = 'e2e-mail'

export function e2eDomain(prefix = 'd'): string {
  return `${prefix}${randomUUID().slice(0, 8)}.${E2E_MAIL_TLD}`
}

export async function fakeAvailable(request: APIRequestContext): Promise<boolean> {
  const res = await request.get('/api/_test/mail/fake')
  return res.ok()
}

export async function fakeControl(request: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const res = await request.post('/api/_test/mail/fake', { data: body })
  if (!res.ok()) throw new Error(`fake control failed: ${res.status()}`)
}

// Posts a raw message to an account's inbound webhook as the fake provider would.
export async function deliverInbound(request: APIRequestContext, inboundMimeUrl: string, signingKey: string, to: string): Promise<void> {
  const raw = [
    'From: Probe <postmaster@example.org>',
    `To: ${to}`,
    'Subject: Receiving check',
    `Message-ID: <${randomUUID()}@example.org>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This message checks that the domain can receive mail.'
  ].join('\r\n')
  const signature = createHmac('sha256', signingKey).update(raw).digest('hex')
  const path = new URL(inboundMimeUrl).pathname
  const res = await request.post(path, {
    data: raw,
    headers: { 'content-type': 'message/rfc822', 'x-fake-signature': signature, 'x-fake-envelope-to': to }
  })
  if (!res.ok()) throw new Error(`inbound webhook failed: ${res.status()} ${await res.text()}`)
}

// Removes every row the mail specs create outside an org.
export async function cleanupMailTestData(): Promise<void> {
  const sql = getHostAdminDb()
  await sql`DELETE FROM mail_stream_routes WHERE domain_id IN (SELECT id FROM mail_domains WHERE domain LIKE ${'%.' + E2E_MAIL_TLD})`
  await sql`DELETE FROM mail_domains WHERE domain LIKE ${'%.' + E2E_MAIL_TLD}`
  await sql`DELETE FROM mail_suppressions WHERE source = ${E2E_MAIL_LABEL}`
  await sql`DELETE FROM core_host_settings WHERE namespace = 'core' AND key IN ('mail_org_send_account', 'mail_org_receive_account')`
  await sql`DELETE FROM mail_accounts WHERE label LIKE ${E2E_MAIL_LABEL + '%'}`
}

export async function insertSuppression(opts: { address: string, reason?: 'hard_bounce' | 'complaint', scope?: 'global' | 'host' | 'org', orgId?: string | null }): Promise<void> {
  const sql = getHostAdminDb()
  await sql`
    INSERT INTO mail_suppressions (address_hash, org_id, scope, reason, source, occurred_at)
    VALUES (encode(sha256(convert_to(lower(btrim(${opts.address})), 'UTF8')), 'hex'), ${opts.orgId ?? null}, ${opts.scope ?? 'global'}, ${opts.reason ?? 'hard_bounce'}, ${E2E_MAIL_LABEL}, now())
  `
}

// Picks an option in a Nuxt UI USelect identified by its accessible name.
export async function pickOption(page: Page, selectName: string | RegExp, option: string | RegExp): Promise<void> {
  await page.getByRole('combobox', { name: selectName }).click()
  await page.getByRole('option', { name: option }).click()
}
