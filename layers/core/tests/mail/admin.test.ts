// The host's /api/admin/mail/* routes, with the fake provider and fake DNS.
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, type AuthHeaders } from '../helpers'
import {
  api, apiError, cleanupCoreMailData, createMailAdmin, createMailOrg, createMailUser, envAccount, envDomain, fakeControl,
  fakeSignature, MAIL_ENV, postRaw, suppress, tenancyLoaded, testAddress, testDomain, webhookPaths
} from './helpers'

interface Account {
  id: string
  source: 'ui' | 'env'
  label: string
  credentials: Record<string, string>
  capabilities: Record<string, boolean>
  webhookUrls: { events: string } | null
}
interface Domain {
  id: string
  domain: string
  source: string
  sendAccountId: string | null
  receiveAccountId: string | null
  probeAddress: string | null
  sendStatus: string
  manualSteps: { send: unknown[], receive: { title: string }[] }
  webhooks: { state: string, required: string[], configured: string[] | null }
  requiredEvents: string[]
}

const SECRET_KEY = 'test-core-mail-secret-AAAA1234'
const SECRET_SIGNING = 'test-core-mail-signing-BBBB5678'

describe('host mail admin', () => {
  const sql = getHostAdminDb()
  let auth: AuthHeaders

  beforeAll(async () => {
    auth = (await createMailAdmin(sql)).auth
  })

  afterEach(async () => {
    await sql`DELETE FROM mail_stream_routes WHERE org_id IS NULL AND domain_id IN (SELECT id FROM mail_domains WHERE domain LIKE 'test-core-mail-%')`
    await fakeControl({ reset: true })
  })

  afterAll(async () => {
    await cleanupCoreMailData(sql)
  })

  async function createAccount(credentials: Record<string, string> = { apiKey: 'test-core-mail-key', signingKey: 'test-core-mail-sig' }) {
    return await api<{ account: Account, verify: { ok: boolean, error?: string, capabilities?: Record<string, boolean> } }>('/api/admin/mail/accounts', {
      method: 'POST', body: { provider: 'fake', label: `test-core-mail-${randomUUID().slice(0, 6)}`, credentials }, ...auth
    })
  }

  async function addDomain(body: Record<string, unknown>) {
    return await api<{ domain: Domain, setup: { roles: { role: string, mode: string }[] } | null }>('/api/admin/mail/domains', { method: 'POST', body: { setupMode: 'manual', ...body }, ...auth })
  }

  const domains = async () => (await api<{ domains: Domain[] }>('/api/admin/mail/domains', auth)).domains
  const accounts = async () => (await api<{ accounts: Account[] }>('/api/admin/mail/accounts', auth)).accounts

  it('secrets are never returned', async () => {
    const { account } = await createAccount({ apiKey: SECRET_KEY, signingKey: SECRET_SIGNING })
    const listed = JSON.stringify(await api('/api/admin/mail/accounts', auth))
    for (const text of [JSON.stringify(account), listed]) {
      expect(text).not.toContain(SECRET_KEY)
      expect(text).not.toContain(SECRET_SIGNING)
    }
    expect(account.credentials).toEqual({ apiKey: '••••1234', signingKey: '••••5678' })
    const [row] = await sql<{ credentials: string }[]>`SELECT credentials FROM mail_accounts WHERE id = ${account.id}`
    expect(row!.credentials).not.toContain(SECRET_KEY)
  })

  it('the env account is read-only and named from code', async () => {
    const env = await envAccount(sql)
    expect((await apiError(`/api/admin/mail/accounts/${env.id}`, { method: 'PATCH', body: { label: 'x' }, ...auth })).statusCode).toBe(409)
    expect((await apiError(`/api/admin/mail/accounts/${env.id}`, { method: 'DELETE', ...auth })).statusCode).toBe(409)
    const listed = (await accounts()).find(a => a.id === env.id)!
    expect(listed.label).toBe('Environment')
    const [row] = await sql<{ label: string | null }[]>`SELECT label FROM mail_accounts WHERE id = ${env.id}`
    expect(row!.label).toBeNull()
  })

  it('verify stores each capability and reports the provider\'s error text', async () => {
    const { account } = await createAccount()
    await addDomain({ domain: testDomain('verify'), sendAccountId: account.id })
    const res = await api<{ account: Account, verify: { ok: boolean } }>(`/api/admin/mail/accounts/${account.id}/verify`, { method: 'POST', ...auth })
    expect(res.verify.ok).toBe(true)
    expect(res.account.capabilities).toEqual({ send: true, suppressionLists: true })
    const [row] = await sql<{ capabilities: Record<string, boolean> }[]>`SELECT capabilities FROM mail_accounts WHERE id = ${account.id}`
    expect(row!.capabilities).toEqual({ send: true, suppressionLists: true })

    const bad = await createAccount({ apiKey: 'invalid' })
    expect(bad.verify).toEqual({ ok: false, error: 'Unauthorized' })
  })

  it('a duplicate host domain is 409; deleting an account a domain uses is 409 naming it', async () => {
    const { account } = await createAccount()
    const name = testDomain('dup')
    await addDomain({ domain: name, sendAccountId: account.id })
    expect((await apiError('/api/admin/mail/domains', { method: 'POST', body: { domain: name, setupMode: 'manual' }, ...auth })).statusCode).toBe(409)
    const del = await apiError(`/api/admin/mail/accounts/${account.id}`, { method: 'DELETE', ...auth })
    expect(del.statusCode).toBe(409)
    expect(del.data?.message).toContain(name)
  })

  it('turning receiving on for the env domain sets its account and returns the manual steps and probe address', async () => {
    const env = await envAccount(sql)
    const envRow = await envDomain(sql)
    try {
      const res = await api<{ domain: Domain, setup: { roles: { role: string, mode: string }[] } }>(`/api/admin/mail/domains/${envRow.id}`, {
        method: 'PATCH', body: { receiveAccountId: env.id }, ...auth
      })
      expect(res.domain.receiveAccountId).toBe(env.id)
      expect(res.domain.probeAddress).toMatch(new RegExp(`^nx-probe-[a-z0-9]+@${MAIL_ENV.MAIL_DOMAIN.replace(/\./g, '\\.')}$`))
      expect(res.domain.manualSteps.receive.length).toBeGreaterThan(0)
      expect(res.setup.roles).toContainEqual({ role: 'receive', mode: 'manual' })
    } finally {
      await api(`/api/admin/mail/domains/${envRow.id}`, { method: 'PATCH', body: { receiveAccountId: null }, ...auth })
    }
  })

  it('the env domain\'s From domain can\'t be changed', async () => {
    const envRow = await envDomain(sql)
    const err = await apiError(`/api/admin/mail/domains/${envRow.id}`, { method: 'PATCH', body: { fromDomain: 'other.example.com' }, ...auth })
    expect(err.statusCode).toBe(409)
  })

  it('confirming manual webhooks stores the event list; a stream change then makes it need updating', async () => {
    const { account } = await createAccount()
    const { domain } = await addDomain({ domain: testDomain('hooks'), sendAccountId: account.id })
    const confirmed = await api<{ domain: Domain }>(`/api/admin/mail/domains/${domain.id}`, { method: 'PATCH', body: { confirmWebhooks: true }, ...auth })
    expect(confirmed.domain.webhooks.configured).toEqual(confirmed.domain.requiredEvents)
    expect(confirmed.domain.webhooks.state).toBe('connected')
    expect(confirmed.domain.requiredEvents).not.toContain('delivered')

    await sql`UPDATE mail_domains SET send_status = 'verified' WHERE id = ${domain.id}`
    try {
      await api('/api/admin/mail/streams', { method: 'PUT', body: { routes: [{ stream: 'account', domainId: domain.id }] }, ...auth })
      const after = (await domains()).find(d => d.id === domain.id)!
      expect(after.requiredEvents).toContain('delivered')
      expect(after.webhooks.state).toBe('needs_update')
      expect(after.webhooks.configured).toEqual(confirmed.domain.requiredEvents)
    } finally {
      await api('/api/admin/mail/streams', { method: 'PUT', body: { routes: [{ stream: 'account', domainId: null }] }, ...auth })
    }
  })

  it('setting the default domain writes the host\'s * route', async () => {
    const { account } = await createAccount()
    const { domain } = await addDomain({ domain: testDomain('default'), sendAccountId: account.id })
    const res = await api<{ defaultDomainId: string | null }>('/api/admin/mail/streams', { method: 'PUT', body: { routes: [{ stream: '*', domainId: domain.id }] }, ...auth })
    expect(res.defaultDomainId).toBe(domain.id)
    const rows = await sql`SELECT domain_id FROM mail_stream_routes WHERE org_id IS NULL AND stream = '*'`
    expect(rows).toEqual([{ domain_id: domain.id }])
    await api('/api/admin/mail/streams', { method: 'PUT', body: { routes: [{ stream: '*', domainId: null }] }, ...auth })
    expect(await sql`SELECT 1 FROM mail_stream_routes WHERE org_id IS NULL AND stream = '*'`).toHaveLength(0)
  })

  it('a domain can\'t use another org\'s account', async (ctx) => {
    if (!await tenancyLoaded(sql)) ctx.skip()
    const org = await createMailOrg(sql)
    const [acct] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (org_id, source, provider, label, capabilities) VALUES (${org.id}, 'ui', 'fake', 'test-core-mail-org', '{}'::jsonb) RETURNING id`
    const err = await apiError('/api/admin/mail/domains', { method: 'POST', body: { domain: testDomain('orgacct'), sendAccountId: acct!.id, setupMode: 'manual' }, ...auth })
    expect(err.statusCode).toBe(422)
  })

  it('the manual DNS check reports SPF, DKIM and DMARC separately and looks for DMARC at the From domain', async () => {
    const { account } = await createAccount()
    const name = testDomain('dns')
    const from = testDomain('from')
    const { domain } = await addDomain({ domain: name, sendAccountId: account.id, fromDomain: from, dkimSelector: 'sel' })
    await fakeControl({ dns: [
      { name, txt: ['v=spf1 include:fake.example ~all'] },
      { name: `_dmarc.${name}`, txt: ['v=DMARC1; p=none'] }
    ] })

    type Check = { check: { roles: { role: string, status: string, checks: { key: string, label: string, ok: boolean | null }[] }[] } }
    const first = await api<Check>(`/api/admin/mail/domains/${domain.id}/check`, { method: 'POST', ...auth })
    const send = first.check.roles.find(r => r.role === 'send')!
    const byKey = (key: string) => send.checks.find(c => c.key === key)!
    expect(byKey('spf')).toMatchObject({ ok: true, label: `SPF record at ${name}` })
    expect(byKey('dkim')).toMatchObject({ ok: false, label: `DKIM record at sel._domainkey.${name}` })
    expect(byKey('dmarc')).toMatchObject({ ok: false, label: `DMARC record at _dmarc.${from}` })

    await fakeControl({ dns: [
      { name: `sel._domainkey.${name}`, txt: ['k=rsa; p=FAKE'] },
      { name: `_dmarc.${from}`, txt: ['v=DMARC1; p=none'] }
    ] })
    const second = await api<Check>(`/api/admin/mail/domains/${domain.id}/check`, { method: 'POST', ...auth })
    const checks = second.check.roles.find(r => r.role === 'send')!.checks
    expect(checks.filter(c => ['spf', 'dkim', 'dmarc'].includes(c.key)).map(c => [c.key, c.ok])).toEqual([['spf', true], ['dkim', true], ['dmarc', true]])
  })

  it('the suppressions list returns no addresses; ?address= returns only that address\'s rows', async () => {
    const a = testAddress('supp-a')
    const b = testAddress('supp-b')
    const a1 = await suppress(sql, a, 'hard_bounce')
    const a2 = await suppress(sql, a, 'complaint')
    const b1 = await suppress(sql, b, 'hard_bounce')

    const all = await api<{ suppressions: { id: string, address?: string }[] }>('/api/admin/mail/suppressions', auth)
    const mine = all.suppressions.filter(s => [a1, a2, b1].includes(s.id))
    expect(mine).toHaveLength(3)
    expect(JSON.stringify(all)).not.toContain('@example.com')
    expect(mine.every(s => s.address === undefined)).toBe(true)

    const found = await api<{ suppressions: { id: string, address?: string }[] }>(`/api/admin/mail/suppressions?address=${encodeURIComponent(a.toUpperCase())}`, auth)
    expect(found.suppressions.map(s => s.id).sort()).toEqual([a1, a2].sort())
    expect(found.suppressions.every(s => s.address === a)).toBe(true)
  })

  it('assigning a needsReceive stream to a send-only domain is 422', async (ctx) => {
    const { streams } = await api<{ streams: { id: string, needsReceive: boolean }[] }>('/api/admin/mail/streams', auth)
    const stream = streams.find(s => s.needsReceive)
    // Core registers no needsReceive stream; the inbox layer's arrives with its retrofit.
    if (!stream) ctx.skip()
    const { account } = await createAccount()
    const { domain } = await addDomain({ domain: testDomain('sendonly'), sendAccountId: account.id })
    await sql`UPDATE mail_domains SET send_status = 'verified' WHERE id = ${domain.id}`
    const err = await apiError('/api/admin/mail/streams', { method: 'PUT', body: { routes: [{ stream: stream!.id, domainId: domain.id }] }, ...auth })
    expect(err.statusCode).toBe(422)
  })

  it('rotation changes the webhook URLs and the old ones 404', async () => {
    const { account } = await createAccount({ apiKey: 'k', signingKey: 'test-core-mail-rot' })
    const before = await webhookPaths(auth, account.id)
    const res = await api<{ urls: { events: string } }>(`/api/admin/mail/accounts/${account.id}/rotate-webhooks`, { method: 'POST', ...auth })
    const after = await webhookPaths(auth, account.id)
    expect(new URL(res.urls.events).pathname).toBe(after.events)
    expect(after.events).not.toBe(before.events)
    const body = JSON.stringify({ events: [] })
    const headers = { 'x-fake-signature': fakeSignature('test-core-mail-rot', body) }
    expect((await postRaw(before.events, body, headers)).status).toBe(404)
    expect((await postRaw(before.inboundMime, body, headers)).status).toBe(404)
    expect((await postRaw(after.events, body, headers)).status).toBe(200)
  })

  it('non-admins get 403 everywhere', async () => {
    const { auth: member } = await createMailUser(sql)
    const id = randomUUID()
    const routes: [string, string][] = [
      ['GET', '/api/admin/mail/accounts'],
      ['POST', '/api/admin/mail/accounts'],
      ['PATCH', `/api/admin/mail/accounts/${id}`],
      ['DELETE', `/api/admin/mail/accounts/${id}`],
      ['POST', `/api/admin/mail/accounts/${id}/verify`],
      ['POST', `/api/admin/mail/accounts/${id}/rotate-webhooks`],
      ['GET', '/api/admin/mail/domains'],
      ['POST', '/api/admin/mail/domains'],
      ['PATCH', `/api/admin/mail/domains/${id}`],
      ['DELETE', `/api/admin/mail/domains/${id}`],
      ['POST', `/api/admin/mail/domains/${id}/check`],
      ['GET', '/api/admin/mail/streams'],
      ['PUT', '/api/admin/mail/streams'],
      ['GET', '/api/admin/mail/suppressions'],
      ['POST', `/api/admin/mail/suppressions/${id}/clear`],
      ['POST', '/api/admin/mail/test'],
      ['GET', '/api/admin/mail/org-accounts'],
      ['PUT', '/api/admin/mail/org-accounts']
    ]
    for (const [method, path] of routes) {
      const err = await apiError(path, { method: method as 'GET', ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }), ...member })
      expect([method, path, err.statusCode]).toEqual([method, path, 403])
    }
  })
})
