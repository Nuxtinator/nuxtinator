// The org's /api/o/<slug>/mail/* routes (tenancy): the permission, isolation
// between orgs, which host accounts an org's domains may use, and alerts.
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, type AuthHeaders } from '../helpers'
import {
  addMembership, api, apiError, cleanupCoreMailData, createMailAdmin, createMailOrg, createMailUser, envAccount, fakeControl,
  sentTo, suppress, tenancyLoaded, testAddress, testDomain
} from './helpers'

interface Account { id: string, credentials: Record<string, string>, webhookUrls: { events: string } | null }
interface Domain {
  id: string
  domain: string
  sendAccountId: string | null
  receiveAccountId: string | null
  ownershipRecord: { name: string, value: string } | null
  manualSteps: { send: { title: string, detail?: string, values?: { value: string }[] }[], receive: unknown[] }
}

const SECRET_KEY = 'test-core-mail-org-secret-CCCC9012'

describe('org mail routes', () => {
  const sql = getHostAdminDb()
  let multi = false
  let orgA: { id: string, slug: string }
  let orgB: { id: string, slug: string }
  let adminA: AuthHeaders
  let adminAEmail: string
  let adminB: AuthHeaders
  let member: AuthHeaders
  let memberEmail: string

  beforeAll(async () => {
    multi = await tenancyLoaded(sql)
    if (!multi) return
    orgA = await createMailOrg(sql)
    orgB = await createMailOrg(sql)
    const a = await createMailUser(sql)
    const b = await createMailUser(sql)
    const m = await createMailUser(sql)
    await addMembership(sql, a.user.id, orgA.id, ['admin'])
    await addMembership(sql, b.user.id, orgB.id, ['admin'])
    await addMembership(sql, m.user.id, orgA.id, ['member'])
    adminA = a.auth
    adminAEmail = a.user.email
    adminB = b.auth
    member = m.auth
    memberEmail = m.user.email
  })

  afterEach(async () => {
    await fakeControl({ reset: true })
  })

  afterAll(async () => {
    if (multi) await cleanupCoreMailData(sql)
  })

  const base = (org: { slug: string }) => `/api/o/${org.slug}/mail`

  async function createAccount(auth: AuthHeaders, org: { slug: string }, apiKey = 'test-core-mail-org-key') {
    return (await api<{ account: Account }>(`${base(org)}/accounts`, {
      method: 'POST', body: { provider: 'fake', label: `test-core-mail-${randomUUID().slice(0, 6)}`, credentials: { apiKey, signingKey: 'test-core-mail-org-sig' } }, ...auth
    })).account
  }

  async function addDomain(auth: AuthHeaders, org: { slug: string }, body: Record<string, unknown> = {}) {
    return (await api<{ domain: Domain }>(`${base(org)}/domains`, { method: 'POST', body: { domain: testDomain('org'), ...body }, ...auth })).domain
  }

  async function verifyOwnership(auth: AuthHeaders, org: { slug: string }, domain: Domain) {
    await fakeControl({ dns: [{ name: domain.ownershipRecord!.name, txt: [domain.ownershipRecord!.value] }] })
    return await api<{ ok: boolean, domain: Domain }>(`${base(org)}/domains/${domain.id}/verify-ownership`, { method: 'POST', ...auth })
  }

  it('a member without org.mail.manage gets 403 on every route', async (ctx) => {
    if (!multi) ctx.skip()
    const id = randomUUID()
    const routes: [string, string][] = [
      ['GET', '/accounts'],
      ['POST', '/accounts'],
      ['PATCH', `/accounts/${id}`],
      ['DELETE', `/accounts/${id}`],
      ['POST', `/accounts/${id}/verify`],
      ['POST', `/accounts/${id}/rotate-webhooks`],
      ['GET', '/domains'],
      ['POST', '/domains'],
      ['PATCH', `/domains/${id}`],
      ['DELETE', `/domains/${id}`],
      ['POST', `/domains/${id}/check`],
      ['POST', `/domains/${id}/verify-ownership`],
      ['GET', '/streams'],
      ['PUT', '/streams'],
      ['GET', '/suppressions'],
      ['POST', `/suppressions/${id}/clear`]
    ]
    for (const [method, path] of routes) {
      const err = await apiError(`${base(orgA)}${path}`, { method: method as 'GET', ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }), ...member })
      expect([method, path, err.statusCode]).toEqual([method, path, 403])
    }
  })

  it('org A can\'t read or change org B\'s rows by id (404)', async (ctx) => {
    if (!multi) ctx.skip()
    const account = await createAccount(adminB, orgB)
    const domain = await addDomain(adminB, orgB)
    const suppression = await suppress(sql, testAddress('org-b'), 'complaint', 'org', orgB.id)

    const routes: [string, string][] = [
      ['PATCH', `/accounts/${account.id}`],
      ['DELETE', `/accounts/${account.id}`],
      ['POST', `/accounts/${account.id}/verify`],
      ['POST', `/accounts/${account.id}/rotate-webhooks`],
      ['PATCH', `/domains/${domain.id}`],
      ['DELETE', `/domains/${domain.id}`],
      ['POST', `/domains/${domain.id}/check`],
      ['POST', `/domains/${domain.id}/verify-ownership`],
      ['POST', `/suppressions/${suppression}/clear`]
    ]
    for (const [method, path] of routes) {
      const err = await apiError(`${base(orgA)}${path}`, { method: method as 'POST', ...(method === 'DELETE' ? {} : { body: {} }), ...adminA })
      expect([method, path, err.statusCode]).toEqual([method, path, 404])
    }
    const listed = JSON.stringify([
      await api(`${base(orgA)}/accounts`, adminA),
      await api(`${base(orgA)}/domains`, adminA),
      await api(`${base(orgA)}/suppressions`, adminA)
    ])
    for (const id of [account.id, domain.id, suppression]) expect(listed).not.toContain(id)
    const [row] = await sql<{ cleared_at: Date | null }[]>`SELECT cleared_at FROM mail_suppressions WHERE id = ${suppression}`
    expect(row!.cleared_at).toBeNull()
  })

  it('org secrets are never returned', async (ctx) => {
    if (!multi) ctx.skip()
    const account = await createAccount(adminA, orgA, SECRET_KEY)
    expect(account.credentials.apiKey).toBe('••••9012')
    await addDomain(adminA, orgA, { sendAccountId: account.id, credentials: { sendingKey: SECRET_KEY } })
    const texts = [
      JSON.stringify(account),
      JSON.stringify(await api(`${base(orgA)}/accounts`, adminA)),
      JSON.stringify(await api(`${base(orgA)}/domains`, adminA))
    ]
    for (const text of texts) expect(text).not.toContain(SECRET_KEY)
  })

  it('an org rotates its own account\'s webhook URLs', async (ctx) => {
    if (!multi) ctx.skip()
    const account = await createAccount(adminA, orgA)
    const res = await api<{ account: Account, urls: { events: string } }>(`${base(orgA)}/accounts/${account.id}/rotate-webhooks`, { method: 'POST', ...adminA })
    expect(res.urls.events).not.toBe(account.webhookUrls!.events)
    expect(res.account.webhookUrls!.events).toBe(res.urls.events)
  })

  it('an org domain uses the host\'s designated org accounts, and no other host account', async (ctx) => {
    if (!multi) ctx.skip()
    const env = await envAccount(sql)
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (source, provider, label, capabilities) VALUES ('ui', 'fake', ${`test-core-mail-host-${randomUUID().slice(0, 6)}`}, '{}'::jsonb) RETURNING id`

    expect((await apiError(`${base(orgA)}/domains`, { method: 'POST', body: { domain: testDomain('other'), receiveAccountId: other!.id }, ...adminA })).statusCode).toBe(422)

    const domain = await addDomain(adminA, orgA)
    expect(domain.sendAccountId).toBe(env.id)
    expect(domain.receiveAccountId).toBe(env.id)
    expect((await verifyOwnership(adminA, orgA, domain)).ok).toBe(true)

    const patch = (body: Record<string, unknown>) => apiError(`${base(orgA)}/domains/${domain.id}`, { method: 'PATCH', body, ...adminA })
    expect((await patch({ receiveAccountId: other!.id })).statusCode).toBe(422)
    expect((await patch({ sendAccountId: other!.id })).statusCode).toBe(422)
    await api(`${base(orgA)}/domains/${domain.id}`, { method: 'PATCH', body: { receiveAccountId: null }, ...adminA })
    const back = await api<{ domain: Domain }>(`${base(orgA)}/domains/${domain.id}`, { method: 'PATCH', body: { receiveAccountId: env.id }, ...adminA })
    expect(back.domain.receiveAccountId).toBe(env.id)
  })

  it('an org domain set up by hand on the host\'s account gets the steps, for the host\'s admins, without webhook URLs', async (ctx) => {
    if (!multi) ctx.skip()
    const domain = await addDomain(adminA, orgA, { setupMode: 'manual' })
    expect((await verifyOwnership(adminA, orgA, domain)).ok).toBe(true)
    const listed = (await api<{ domains: Domain[] }>(`${base(orgA)}/domains`, adminA)).domains.find(d => d.id === domain.id)!
    const steps = listed.manualSteps.send
    expect(steps.length).toBeGreaterThan(1)
    expect(steps[0]!.title).toContain('host')
    expect(steps.some(s => s.title.includes(domain.domain))).toBe(true)
    expect(JSON.stringify(steps)).not.toContain('/api/mail/webhooks/')
  })

  it('a lost role emails the org\'s admins and the host\'s; a lapsed claim only the org\'s', async (ctx) => {
    if (!multi) ctx.skip()
    const { user: host } = await createMailAdmin(sql)
    const name = testDomain('alert')
    await fakeControl({ alert: { kind: 'role_lost', orgId: orgA.id, domain: name, role: 'send' } })
    expect(await sentTo(adminAEmail)).toHaveLength(1)
    expect(await sentTo(host.email)).toHaveLength(1)
    expect(await sentTo(memberEmail)).toHaveLength(0)
    expect((await sentTo(host.email))[0]!.subject).toContain(name)

    await fakeControl({ alert: { kind: 'ownership_lapsed', orgId: orgA.id, domain: name } })
    expect(await sentTo(adminAEmail)).toHaveLength(2)
    expect(await sentTo(host.email)).toHaveLength(1)
  })
})
