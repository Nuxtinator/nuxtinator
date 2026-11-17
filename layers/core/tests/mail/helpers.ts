// Helpers for the core-mail project: the server URL, the fake provider's
// test routes, Mailpit's From header, and cleanup of everything prefixed
// `test-core-mail`.
import type postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { inject } from 'vitest'
import { $fetch as ofetch, type FetchOptions } from 'ofetch'
import { addressHash } from '@nuxtinator/mail/kernel'
import { fakeSignature } from '@nuxtinator/mail/test'
import { createTestUser, getAuthHeaders, type AuthHeaders, type TestUser } from '../helpers'

export const MAIL_ENV = {
  MAIL_TRANSPORT: 'provider',
  MAIL_FAKE_PROVIDER: '1',
  MAIL_PROVIDER: 'fake',
  MAIL_FAKE_API_KEY: 'test-core-mail-env-key',
  MAIL_FAKE_SIGNING_KEY: 'test-core-mail-env-signing',
  MAIL_DOMAIN: process.env.MAIL_DOMAIN || process.env.MAILGUN_DOMAIN || 'mail.test.local',
  SMTP_FROM: process.env.SMTP_FROM || 'noreply@example.com'
}

export { addressHash, fakeSignature }

type Sql = ReturnType<typeof postgres>

// Requests against this project's server (not whichever server another
// project exposed through the environment).
export function api<T = any>(path: string, opts: FetchOptions<'json'> = {}): Promise<T> {
  return ofetch<T>(path, { baseURL: inject('coreMailUrl'), ...opts } as FetchOptions<'json'>) as Promise<T>
}

export async function apiError(path: string, opts: FetchOptions<'json'> = {}): Promise<{ statusCode: number, statusMessage?: string, data?: any }> {
  try {
    await api(path, opts)
  } catch (err) {
    const e = err as { statusCode?: number, statusMessage?: string, data?: any }
    return { statusCode: e.statusCode ?? 0, statusMessage: e.data?.statusMessage ?? e.data?.message ?? e.statusMessage, data: e.data }
  }
  throw new Error(`${opts.method ?? 'GET'} ${path} succeeded`)
}

// A raw POST whose body is sent byte for byte, for signed webhooks.
export async function postRaw(path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number, body: any }> {
  const res = await fetch(new URL(path, inject('coreMailUrl')), { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, body: parsed }
}

export function testAddress(tag = 'user'): string {
  return `test-core-mail-${tag}-${randomUUID().slice(0, 8)}@example.com`
}

export function testDomain(tag = 'd'): string {
  return `test-core-mail-${tag}-${randomUUID().slice(0, 8)}.example.com`
}

export async function createMailUser(sql: Sql, opts: Parameters<typeof createTestUser>[1] = {}): Promise<{ user: TestUser, auth: AuthHeaders }> {
  const user = await createTestUser(sql, { email: testAddress('user'), ...opts })
  return { user, auth: getAuthHeaders(user) }
}

export async function createMailAdmin(sql: Sql) {
  return await createMailUser(sql, { email: testAddress('admin'), is_admin: true })
}

export async function tenancyLoaded(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`select to_regclass('orgs') is not null as present`
  return !!row?.present
}

export async function createMailOrg(sql: Sql): Promise<{ id: string, slug: string }> {
  const id = randomUUID()
  const slug = `test-core-mail-${randomUUID().slice(0, 8)}`
  await sql`INSERT INTO orgs (id, slug, name) VALUES (${id}, ${slug}, ${`Test ${slug}`})`
  await sql`INSERT INTO org_apps (org_id, app_id, enabled, source) SELECT ${id}, a.id, true, 'auto' FROM apps a`
  return { id, slug }
}

export async function addMembership(sql: Sql, userId: string, orgId: string, roles: string[]) {
  await sql`INSERT INTO memberships (id, user_id, org_id, roles) VALUES (${randomUUID()}, ${userId}, ${orgId}, ${roles})`
}

export async function suppress(sql: Sql, address: string, reason: 'hard_bounce' | 'complaint', scope: 'global' | 'host' | 'org' = reason === 'hard_bounce' ? 'global' : 'host', orgId: string | null = null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO mail_suppressions (address_hash, org_id, scope, reason, detail, source, occurred_at)
    VALUES (${addressHash(address)}, ${orgId}, ${scope}, ${reason}, 'test-core-mail', 'test', now())
    RETURNING id`
  return row!.id
}

export interface FakeState {
  sent: { to: string, from: { name: string | null, address: string }, domain: string, subject: string, correlation: { stream: string, orgId: string | null, ref: string | null } }[]
  released: { domain: string, address: string, list: string }[]
  provisioned: { domain: string, role: string }[]
  webhooksConfigured: { domain: string, events: string[] }[]
}

export async function fakeState(): Promise<FakeState> {
  return await api<FakeState>('/api/_test/mail/fake')
}

export async function fakeControl(body: Record<string, unknown>) {
  await api('/api/_test/mail/fake', { method: 'POST', body })
}

export async function sentTo(address: string) {
  return (await fakeState()).sent.filter(m => m.to === address)
}

// The From of the newest Mailpit message to `address`.
export async function mailpitFrom(address: string, timeoutMs = 5000): Promise<{ Address: string, Name: string }> {
  const base = process.env.TEST_MAILHOG_URL || 'http://localhost:8025'
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base}/api/v1/messages?limit=200`)
    const list = (await res.json() as { messages: { To: { Address: string }[], From: { Address: string, Name: string } }[] }).messages ?? []
    const hit = list.find(m => m.To.some(t => t.Address.toLowerCase() === address.toLowerCase()))
    if (hit) return hit.From
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`No mail to ${address} reached Mailpit within ${timeoutMs}ms`)
}

export async function envAccount(sql: Sql): Promise<{ id: string, webhook_token_version: number }> {
  const [row] = await sql<{ id: string, webhook_token_version: number }[]>`SELECT id, webhook_token_version FROM mail_accounts WHERE source = 'env'`
  return row!
}

export async function envDomain(sql: Sql): Promise<{ id: string, domain: string, from_domain: string | null }> {
  const [row] = await sql<{ id: string, domain: string, from_domain: string | null }[]>`SELECT id, domain, from_domain FROM mail_domains WHERE source = 'env'`
  return row!
}

// The URL path of an account's webhook, from the admin API.
export async function webhookPaths(auth: AuthHeaders, accountId: string): Promise<{ events: string, inbound: string, inboundMime: string }> {
  const res = await api<{ accounts: { id: string, webhookUrls: { events: string, inbound: string, inboundMime: string } | null }[] }>('/api/admin/mail/accounts', auth)
  const urls = res.accounts.find(a => a.id === accountId)!.webhookUrls!
  return { events: new URL(urls.events).pathname, inbound: new URL(urls.inbound).pathname, inboundMime: new URL(urls.inboundMime).pathname }
}

export async function cleanupCoreMailData(sql: Sql): Promise<void> {
  await sql`DELETE FROM mail_suppressions WHERE detail LIKE 'test-core-mail%' OR account_id IN (SELECT id FROM mail_accounts WHERE label LIKE 'test-core-mail%')`
  await sql`DELETE FROM mail_domains WHERE domain LIKE 'test-core-mail-%'`
  if (await tenancyLoaded(sql)) {
    await sql`DELETE FROM mail_accounts WHERE label LIKE 'test-core-mail%' OR org_id IN (SELECT id FROM orgs WHERE slug LIKE 'test-core-mail-%')`
  } else {
    await sql`DELETE FROM mail_accounts WHERE label LIKE 'test-core-mail%'`
  }
  await sql`UPDATE mail_domains SET receive_account_id = NULL, receive_status = 'pending', probe_token = NULL WHERE source = 'env' AND receive_account_id IS NOT NULL`
  await sql`DELETE FROM invites WHERE email LIKE 'test-core-mail-%@example.com' OR invited_by IN (SELECT id FROM users WHERE email LIKE 'test-core-mail-%@example.com')`
  await sql`DELETE FROM activity_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-core-mail-%@example.com')`
  await sql`DELETE FROM activity_logs WHERE event_type IN ('PASSWORD_RESET_REQUEST', 'SHARE_INVITE_EMAIL', 'RATE_LIMIT_EXCEEDED') AND metadata->>'email' LIKE 'test-core-mail-%@example.com'`
  await sql`DELETE FROM password_reset_requests WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-core-mail-%@example.com')`
  if (await tenancyLoaded(sql)) await sql`DELETE FROM orgs WHERE slug LIKE 'test-core-mail-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-core-mail-%@example.com'`
}
