import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { encryptJson, MailAdminError } from '../kernel'
import { db, harness, insertAccount, mailFor, orgId, resetTables, SECRET } from './helpers'

beforeEach(resetTables)
afterAll(async () => {
  await db().destroy()
})

const BASE = 'https://app.example.org'

async function hostAccount() {
  return await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k', signingKey: 's' }), capabilities: JSON.stringify({ domains: true, webhooks: true, suppressionLists: true }) })
}

function txt(h: ReturnType<typeof harness>, name: string, value: string) {
  h.dns.records.set(name, { ...(h.dns.records.get(name) ?? {}), txt: [value] })
}

describe('org domains: ownership', () => {
  it('an org domain makes no provider call and accepts no routes until ownership is verified', async () => {
    const h = harness()
    const acct = await hostAccount()
    const org = await orgId()
    const { domain } = await h.mail.admin.addDomain({ orgId: org }, { domain: 'pray.church.test', sendAccountId: acct.id }, BASE)
    expect(domain.ownership_status).toBe('pending')
    expect(h.fake.provisioned).toEqual([])
    await expect(h.mail.admin.setStreamRoute({ orgId: org }, '*', domain.id, BASE)).rejects.toMatchObject({ statusCode: 409 })
    const check = await h.mail.admin.checkDomain({ orgId: org }, domain.id, BASE)
    expect(check.ownership?.ok).toBe(false)
    expect(h.fake.provisioned).toEqual([])

    txt(h, '_nx-verify.pray.church.test', `nx-verify=${domain.ownership_token}`)
    const ok = await h.mail.admin.checkDomain({ orgId: org }, domain.id, BASE)
    expect(ok.ownership?.ok).toBe(true)
    expect(h.fake.provisioned).toEqual([{ domain: 'pray.church.test', role: 'send' }])
  })

  it('an org can\'t take the env domain, a verified host domain, or another org\'s domain', async () => {
    const h = harness()
    await h.mail.syncEnvAccount()
    const acct = await hostAccount()
    await h.mail.admin.addDomain({ orgId: null }, { domain: 'host.example.net', sendAccountId: acct.id }, BASE)
    const a = await orgId()
    const b = await orgId()
    for (const name of ['mg.example.org', 'host.example.net']) {
      const { domain } = await h.mail.admin.addDomain({ orgId: a }, { domain: name, sendAccountId: acct.id }, BASE)
      // Whatever TXT record exists, it isn't this claim's token.
      txt(h, `_nx-verify.${name}`, 'nx-verify=someone-else')
      expect((await h.mail.admin.verifyOwnership({ orgId: a }, domain.id, BASE)).ok).toBe(false)
      expect((await h.mail.resolveSender('newsletter', a))!.domain).not.toBe(domain.domain + '-org')
    }
    const { domain: own } = await h.mail.admin.addDomain({ orgId: a }, { domain: 'a.church.test', sendAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.a.church.test', `nx-verify=${own.ownership_token}`)
    await h.mail.admin.verifyOwnership({ orgId: a }, own.id, BASE)
    const { domain: claim } = await h.mail.admin.addDomain({ orgId: b }, { domain: 'a.church.test', sendAccountId: acct.id }, BASE)
    expect((await h.mail.admin.verifyOwnership({ orgId: b }, claim.id, BASE)).ok).toBe(false)
  })

  it('the first of two pending claims to verify owns the name; the other is deleted; stale claims expire', async () => {
    const h = harness()
    const acct = await hostAccount()
    const a = await orgId()
    const b = await orgId()
    const { domain: ca } = await h.mail.admin.addDomain({ orgId: a }, { domain: 'both.test', sendAccountId: acct.id }, BASE)
    const { domain: cb } = await h.mail.admin.addDomain({ orgId: b }, { domain: 'both.test', sendAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.both.test', `nx-verify=${cb.ownership_token}`)
    expect((await h.mail.admin.verifyOwnership({ orgId: b }, cb.id, BASE)).ok).toBe(true)
    const rows = await db().selectFrom('mail_domains').select(['id', 'org_id']).where('domain', '=', 'both.test').execute()
    expect(rows).toEqual([{ id: cb.id, org_id: b }])
    expect(ca.id).not.toBe(cb.id)

    const { domain: stale } = await h.mail.admin.addDomain({ orgId: a }, { domain: 'stale.test', sendAccountId: acct.id }, BASE)
    await db().updateTable('mail_domains').set({ created_at: sql`now() - interval '8 days'` }).where('id', '=', stale.id).execute()
    await h.mail.admin.runDailyJob({ baseUrl: BASE })
    expect(await db().selectFrom('mail_domains').select('id').where('id', '=', stale.id).executeTakeFirst()).toBeUndefined()
  })

  it('the daily recheck lapses after three failures, alerts once, and a passing check restores it', async () => {
    const h = harness()
    await h.mail.syncEnvAccount()
    const acct = await hostAccount()
    const org = await orgId()
    const { domain } = await h.mail.admin.addDomain({ orgId: org }, { domain: 'lapse.test', sendAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.lapse.test', `nx-verify=${domain.ownership_token}`)
    await h.mail.admin.checkDomain({ orgId: org }, domain.id, BASE)
    await h.mail.admin.setStreamRoute({ orgId: org }, '*', domain.id, BASE)
    expect((await h.mail.resolveSender('newsletter', org))!.domain).toBe('lapse.test')

    const alerts: unknown[] = []
    h.dns.records.delete('_nx-verify.lapse.test')
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect((await h.mail.admin.getDomain({ orgId: org }, domain.id)).ownership_status).toBe('verified')
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect((await h.mail.admin.getDomain({ orgId: org }, domain.id)).ownership_status).toBe('lapsed')
    expect(alerts).toEqual([{ kind: 'ownership_lapsed', orgId: org, domain: 'lapse.test' }])
    expect((await h.mail.resolveSender('newsletter', org))!.domain).toBe('mg.example.org')
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect(alerts).toHaveLength(1)

    txt(h, '_nx-verify.lapse.test', `nx-verify=${domain.ownership_token}`)
    await h.mail.admin.runDailyJob({ baseUrl: BASE })
    expect((await h.mail.admin.getDomain({ orgId: org }, domain.id)).ownership_status).toBe('verified')
  })

  it('an org can\'t read another org\'s rows or use its account', async () => {
    const h = harness()
    const a = await orgId()
    const b = await orgId()
    const acctA = await insertAccount({ org_id: a, credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    await expect(h.mail.admin.getAccount({ orgId: b }, acctA.id)).rejects.toBeInstanceOf(MailAdminError)
    await expect(h.mail.admin.addDomain({ orgId: b }, { domain: 'b.test', sendAccountId: acctA.id }, BASE)).rejects.toMatchObject({ statusCode: 422 })
    await expect(h.mail.admin.addDomain({ orgId: null }, { domain: 'h.test', sendAccountId: acctA.id }, BASE)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('newsletters move to the org domain once it sends; inbox mail only once it also receives', async () => {
    const h = harness()
    await h.mail.syncEnvAccount()
    const acct = await hostAccount()
    const inbox = await h.mail.admin.addDomain({ orgId: null }, { domain: 'inbox.host.test', sendAccountId: acct.id, receiveAccountId: acct.id }, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, inbox.domain.id, BASE)
    await h.mail.admin.setStreamRoute({ orgId: null }, 'inbox', inbox.domain.id, BASE)
    const org = await orgId()
    const { domain } = await h.mail.admin.addDomain({ orgId: org }, { domain: 'own.church.test', sendAccountId: acct.id, receiveAccountId: acct.id, setupMode: 'auto' }, BASE)
    txt(h, '_nx-verify.own.church.test', `nx-verify=${domain.ownership_token}`)
    h.fake.control.domainStatus = 'verified'
    await h.mail.admin.checkDomain({ orgId: org }, domain.id, BASE)
    await db().updateTable('mail_domains').set({ receive_status: 'pending' }).where('id', '=', domain.id).execute()
    await h.mail.admin.setStreamRoute({ orgId: org }, '*', domain.id, BASE)
    expect((await h.mail.resolveSender('newsletter', org))!.domain).toBe('own.church.test')
    expect((await h.mail.resolveSender('inbox', org))!.domain).toBe('inbox.host.test')
    await db().updateTable('mail_domains').set({ receive_status: 'verified' }).where('id', '=', domain.id).execute()
    expect((await h.mail.resolveSender('inbox', org))!.domain).toBe('own.church.test')
    expect((await h.mail.resolveSender('account', org))!.domain).toBe('mg.example.org')
  })
})

describe('host domains', () => {
  it('a duplicate host domain is 409; an account in use can\'t be deleted', async () => {
    const h = harness()
    const acct = await hostAccount()
    await h.mail.admin.addDomain({ orgId: null }, { domain: 'dup.test', sendAccountId: acct.id }, BASE)
    await expect(h.mail.admin.addDomain({ orgId: null }, { domain: 'DUP.test', sendAccountId: acct.id }, BASE)).rejects.toMatchObject({ statusCode: 409 })
    await expect(h.mail.admin.deleteAccount({ orgId: null }, acct.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('dup.test') })
  })

  it('a key refused for domains falls back to manual and records the capability', async () => {
    const h = harness()
    h.fake.control.capabilities = { ...h.fake.control.capabilities, domains: false }
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const res = await h.mail.admin.addDomain({ orgId: null }, { domain: 'limited.test', sendAccountId: acct.id }, BASE)
    expect(res.setup?.roles).toEqual([expect.objectContaining({ role: 'send', mode: 'manual' })])
    expect(res.domain.setup_mode).toBe('manual')
    expect((await h.mail.admin.getAccount({ orgId: null }, acct.id)).capabilities).toMatchObject({ domains: false })
  })

  it('the manual DNS check reports each record and looks for DMARC at the From domain', async () => {
    const h = harness()
    const acct = await hostAccount()
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'mg.manual.test', sendAccountId: acct.id, setupMode: 'manual', dkimSelector: 'k1', fromDomain: 'manual.test' }, BASE)
    txt(h, 'mg.manual.test', 'v=spf1 include:fake ~all')
    txt(h, '_dmarc.manual.test', 'v=DMARC1; p=none')
    const check = await h.mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    const send = check.roles.find(r => r.role === 'send')!
    expect(send.status).toBe('verified')
    expect(Object.fromEntries(send.checks.map(c => [c.key, c.ok]))).toMatchObject({ provider: true, spf: true, dkim: false, dmarc: true, dns: false })
  })

  it('receiving on a domain verifies when the probe arrives', async () => {
    const h = harness()
    await h.mail.syncEnvAccount()
    const env = await db().selectFrom('mail_accounts').selectAll().where('source', '=', 'env').executeTakeFirstOrThrow()
    const envDomain = await db().selectFrom('mail_domains').selectAll().where('source', '=', 'env').executeTakeFirstOrThrow()
    const res = await h.mail.admin.patchDomain({ orgId: null }, envDomain.id, { receiveAccountId: env.id }, BASE)
    expect(res.domain.probe_token).toBeTruthy()
    const check = await h.mail.admin.checkDomain({ orgId: null }, envDomain.id, BASE)
    expect(check.roles.find(r => r.role === 'receive')!.status).toBe('pending')
    const probe = h.fake.sent.find(m => m.to.startsWith('nx-probe-'))!
    expect(probe.correlation.stream).toBe('nx-probe')
    await expect(h.mail.admin.patchDomain({ orgId: null }, envDomain.id, { fromDomain: 'x.test' }, BASE)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a needsReceive stream refuses a send-only domain; the default route sends everything', async () => {
    const h = harness({ env: {} })
    const acct = await hostAccount()
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'only.test', sendAccountId: acct.id, makeDefault: true }, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    await expect(h.mail.admin.setStreamRoute({ orgId: null }, 'inbox', domain.id, BASE)).rejects.toMatchObject({ statusCode: 422 })
    expect((await h.mail.send(mailFor('a@x.test'))).status).toBe('sent')
  })

  it('stream changes update the webhook event list; delivered only when a stream needs it', async () => {
    const h = harness({ env: {} })
    const acct = await hostAccount()
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'bulk.test', sendAccountId: acct.id }, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    await h.mail.admin.setStreamRoute({ orgId: null }, 'newsletter', domain.id, BASE)
    expect(await h.mail.admin.requiredEvents(await h.mail.admin.getDomain({ orgId: null }, domain.id))).not.toContain('delivered')
    await h.mail.admin.setStreamRoute({ orgId: null }, '*', domain.id, BASE)
    expect(await h.mail.admin.requiredEvents(await h.mail.admin.getDomain({ orgId: null }, domain.id))).toContain('delivered')
    expect(h.fake.webhooksConfigured.at(-1)!.events).toContain('delivered')
    const status = await h.mail.admin.webhookStatus(await h.mail.admin.getDomain({ orgId: null }, domain.id))
    expect(status.state).toBe('connected')
  })

  it('rotation changes the webhook URLs', async () => {
    const h = harness()
    const acct = await hostAccount()
    const before = h.mail.webhookUrls(acct, BASE)
    const res = await h.mail.admin.rotateWebhooks({ orgId: null }, acct.id, BASE)
    expect(res.urls.events).not.toBe(before.events)
  })

  it('clearing a suppression releases the address on mirrored domains', async () => {
    const h = harness()
    const acct = await hostAccount()
    await h.mail.admin.addDomain({ orgId: null }, { domain: 'm.test', sendAccountId: acct.id }, BASE)
    await h.mail.handleEvents(acct, [{ type: 'bounced', permanent: true, recipient: 'x@y.test', providerMessageId: null, occurredAt: new Date(), detail: null, stream: null, orgId: null, ref: null }])
    const [row] = await h.mail.admin.listSuppressions({ orgId: null })
    expect(row).not.toHaveProperty('address')
    const found = await h.mail.admin.listSuppressions({ orgId: null }, { address: 'X@y.test' })
    expect(found[0]!.address).toBe('x@y.test')
    await h.mail.admin.clearSuppression({ orgId: null }, row!.id, 'x@y.test')
    expect(h.fake.released).toEqual([{ domain: 'm.test', address: 'x@y.test', list: 'bounce' }])
    expect(await h.mail.isSuppressed('x@y.test')).toBe(false)
  })
})
