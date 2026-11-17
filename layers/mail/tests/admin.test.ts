import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { encryptJson, MailAdminError, ProviderPermissionError, type InboundMail, type MailStream } from '../kernel'
import { jsonb } from '../kernel/json'
import { db, harness, insertAccount, insertDomain, mailFor, orgId, pg, resetTables, route, SECRET } from './helpers'

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
    const { domain: own } = await h.mail.admin.addDomain({ orgId: a }, { domain: 'a.church.test', sendAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.a.church.test', `nx-verify=${own.ownership_token}`)
    await h.mail.admin.verifyOwnership({ orgId: a }, own.id, BASE)
    const provisioned = h.fake.provisioned.length
    const verifyCalls = h.fake.verifyCalls.length

    for (const name of ['mg.example.org', 'host.example.net', 'a.church.test']) {
      const { domain: claim } = await h.mail.admin.addDomain({ orgId: b }, { domain: name, sendAccountId: acct.id }, BASE)
      // Whatever TXT record exists, it isn't this claim's token.
      expect((await h.mail.admin.verifyOwnership({ orgId: b }, claim.id, BASE)).ok).toBe(false)
      expect((await h.mail.admin.getDomain({ orgId: b }, claim.id)).ownership_status).toBe('pending')
      await expect(h.mail.admin.setStreamRoute({ orgId: b }, '*', claim.id, BASE)).rejects.toMatchObject({ statusCode: 409 })
    }
    expect((await h.mail.resolveSender('newsletter', b))!.domain).toBe('mg.example.org')
    expect(h.fake.provisioned).toHaveLength(provisioned)
    expect(h.fake.verifyCalls).toHaveLength(verifyCalls)
  })

  it('a second org whose own TXT record passes still can\'t take a name another holds as verified', async () => {
    const h = harness()
    const acct = await hostAccount()
    const a = await orgId()
    const b = await orgId()
    await h.mail.admin.addDomain({ orgId: null }, { domain: 'host.example.net', sendAccountId: acct.id }, BASE)
    const { domain: onHost } = await h.mail.admin.addDomain({ orgId: b }, { domain: 'host.example.net', sendAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.host.example.net', `nx-verify=${onHost.ownership_token}`)
    await expect(h.mail.admin.verifyOwnership({ orgId: b }, onHost.id, BASE)).rejects.toMatchObject({ statusCode: 409 })

    const { domain: ca } = await h.mail.admin.addDomain({ orgId: a }, { domain: 'held.test', sendAccountId: acct.id }, BASE)
    const { domain: cb } = await h.mail.admin.addDomain({ orgId: b }, { domain: 'held.test', sendAccountId: acct.id }, BASE)
    h.dns.records.set('_nx-verify.held.test', { txt: [`nx-verify=${ca.ownership_token}`, `nx-verify=${cb.ownership_token}`] })
    expect((await h.mail.admin.verifyOwnership({ orgId: a }, ca.id, BASE)).ok).toBe(true)
    // The first claim to verify deleted the second; a fresh one is refused.
    const { domain: again } = await h.mail.admin.addDomain({ orgId: b }, { domain: 'held.test', sendAccountId: acct.id }, BASE)
    h.dns.records.set('_nx-verify.held.test', { txt: [`nx-verify=${ca.ownership_token}`, `nx-verify=${again.ownership_token}`] })
    await expect(h.mail.admin.verifyOwnership({ orgId: b }, again.id, BASE)).rejects.toMatchObject({ statusCode: 409 })
    expect((await h.mail.admin.getDomain({ orgId: a }, ca.id)).ownership_status).toBe('verified')

    // Once the holder's row lapses, the other org can claim it.
    await db().updateTable('mail_domains').set({ ownership_status: 'lapsed' }).where('id', '=', ca.id).execute()
    expect((await h.mail.admin.verifyOwnership({ orgId: b }, again.id, BASE)).ok).toBe(true)
    expect(await db().selectFrom('mail_domains').select('id').where('domain', '=', 'held.test').execute()).toEqual([{ id: again.id }])
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

  it('a claim another org verifies while this one is verifying isn\'t deleted; this one gets a 409', async () => {
    const h = harness()
    const acct = await hostAccount()
    const a = await orgId()
    const b = await orgId()
    const { domain: ca } = await h.mail.admin.addDomain({ orgId: a }, { domain: 'race.test', sendAccountId: acct.id }, BASE)
    const { domain: cb } = await h.mail.admin.addDomain({ orgId: b }, { domain: 'race.test', sendAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.race.test', `nx-verify=${ca.ownership_token}`)

    // Org b's verification is in flight (row locked, not committed) while org a verifies.
    let commit!: () => void
    let updated!: () => void
    const gate = new Promise<void>(resolve => (commit = resolve))
    const locked = new Promise<void>(resolve => (updated = resolve))
    const other = pg().begin(async (t) => {
      await t`update mail_domains set ownership_status = 'verified' where id = ${cb.id}`
      updated()
      await gate
    })
    await locked
    const racing = h.mail.admin.verifyOwnership({ orgId: a }, ca.id, BASE).then(r => r, (e: unknown) => e)
    for (let i = 0; i < 200; i++) {
      const waiting = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%mail_domains%'`.execute(db())
      if (waiting.rows[0]!.n > 0) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    commit()
    await other

    expect(await racing).toMatchObject({ statusCode: 409 })
    const rows = await db().selectFrom('mail_domains').select(['id', 'ownership_status']).where('domain', '=', 'race.test').orderBy('ownership_status').execute()
    expect(rows).toEqual([{ id: ca.id, ownership_status: 'pending' }, { id: cb.id, ownership_status: 'verified' }])
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

describe('the ownership gate', () => {
  it('a pending org domain takes a key without any provider call, and refuses account and webhook changes', async () => {
    const h = harness()
    const acct = await hostAccount()
    const org = await orgId()
    const { domain } = await h.mail.admin.addDomain({ orgId: org }, { domain: 'gate.church.test', sendAccountId: acct.id }, BASE)
    const verifyCalls = h.fake.verifyCalls.length
    await h.mail.admin.patchDomain({ orgId: org }, domain.id, { credentials: { sendingKey: 'domain-key' } }, BASE)
    const stored = await h.mail.admin.getDomain({ orgId: org }, domain.id)
    expect(stored.credentials).toBeTruthy()
    expect(stored.capabilities).toEqual({})
    expect(h.fake.verifyCalls).toHaveLength(verifyCalls)
    expect(h.fake.provisioned).toEqual([])
    for (const input of [{ sendAccountId: null }, { receiveAccountId: acct.id }, { confirmWebhooks: true }]) {
      await expect(h.mail.admin.patchDomain({ orgId: org }, domain.id, input, BASE)).rejects.toMatchObject({ statusCode: 409 })
    }

    // Once ownership is confirmed, the domain's key is probed against it.
    txt(h, '_nx-verify.gate.church.test', `nx-verify=${domain.ownership_token}`)
    await h.mail.admin.verifyOwnership({ orgId: org }, domain.id, BASE)
    expect(h.fake.verifyCalls.slice(verifyCalls)).toContainEqual({ domain: 'gate.church.test' })
    expect((await h.mail.admin.getDomain({ orgId: org }, domain.id)).capabilities).toMatchObject({ send: true })
  })

  it('rotating webhook URLs reconfigures only ownership-verified domains', async () => {
    const h = harness()
    const acct = await hostAccount()
    const org = await orgId()
    const { domain: host } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'rot.host.test', sendAccountId: acct.id }, BASE)
    await h.mail.admin.addDomain({ orgId: org }, { domain: 'rot.claim.test', sendAccountId: acct.id, setupMode: 'auto' }, BASE)
    h.fake.webhooksConfigured.length = 0
    const res = await h.mail.admin.rotateWebhooks({ orgId: null }, acct.id, BASE)
    expect(res.configured).toEqual([host.domain])
    expect(h.fake.webhooksConfigured.map(w => w.domain)).toEqual([host.domain])
  })

  it('the switch can\'t turn on before sending is verified', async () => {
    const h = harness()
    const acct = await hostAccount()
    const org = await orgId()
    h.fake.control.domainStatus = 'pending'
    const { domain } = await h.mail.admin.addDomain({ orgId: org }, { domain: 'switch.church.test', sendAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.switch.church.test', `nx-verify=${domain.ownership_token}`)
    await h.mail.admin.checkDomain({ orgId: org }, domain.id, BASE)
    expect((await h.mail.admin.getDomain({ orgId: org }, domain.id)).send_status).toBe('pending')
    await expect(h.mail.admin.setStreamRoute({ orgId: org }, '*', domain.id, BASE)).rejects.toMatchObject({ statusCode: 409 })
    h.fake.control.domainStatus = 'verified'
    await h.mail.admin.checkDomain({ orgId: org }, domain.id, BASE)
    await h.mail.admin.setStreamRoute({ orgId: org }, '*', domain.id, BASE)
    expect((await h.mail.resolveSender('newsletter', org))!.domain).toBe('switch.church.test')
  })

  it('an org domain uses its own accounts, or only the host account designated for org domains in that role', async () => {
    const h = harness()
    const hostSend = await hostAccount()
    const hostReceive = await hostAccount()
    const other = await hostAccount()
    const org = await orgId()
    const own = await insertAccount({ org_id: org, credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const scope = { orgId: org, hostAccounts: { send: hostSend.id, receive: hostReceive.id } }

    await expect(h.mail.admin.addDomain(scope, { domain: 'x1.test', sendAccountId: other.id }, BASE)).rejects.toMatchObject({ statusCode: 422 })
    await expect(h.mail.admin.addDomain(scope, { domain: 'x2.test', sendAccountId: hostSend.id, receiveAccountId: hostSend.id }, BASE)).rejects.toMatchObject({ statusCode: 422 })
    const { domain } = await h.mail.admin.addDomain(scope, { domain: 'x3.test', sendAccountId: hostSend.id, receiveAccountId: hostReceive.id }, BASE)
    txt(h, '_nx-verify.x3.test', `nx-verify=${domain.ownership_token}`)
    await h.mail.admin.verifyOwnership(scope, domain.id, BASE)

    await expect(h.mail.admin.patchDomain(scope, domain.id, { receiveAccountId: other.id }, BASE)).rejects.toMatchObject({ statusCode: 422 })
    await expect(h.mail.admin.patchDomain(scope, domain.id, { sendAccountId: hostReceive.id }, BASE)).rejects.toMatchObject({ statusCode: 422 })
    // Keeping the account it has, or moving to the org's own, is fine.
    await h.mail.admin.patchDomain(scope, domain.id, { receiveAccountId: hostReceive.id }, BASE)
    const moved = await h.mail.admin.patchDomain(scope, domain.id, { receiveAccountId: own.id }, BASE)
    expect(moved.domain.receive_account_id).toBe(own.id)
  })
})

describe('host adds and deletes', () => {
  it('a host add removes orgs\' pending and lapsed rows for the name; deleting a row leaves a provider registration another row uses', async () => {
    const h = harness()
    const acct = await hostAccount()
    const a = await orgId()
    const b = await orgId()
    await h.mail.admin.addDomain({ orgId: a }, { domain: 'taken.test', sendAccountId: acct.id }, BASE)
    await insertDomain({ org_id: b, domain: 'taken.test', ownership_status: 'lapsed', send_account_id: acct.id })
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'taken.test', sendAccountId: acct.id }, BASE)
    expect(await db().selectFrom('mail_domains').select('id').where('domain', '=', 'taken.test').execute()).toEqual([{ id: domain.id }])

    const deprovisioned: string[] = []
    h.fake.deprovisionDomain = async (_c, name) => void deprovisioned.push(name)
    const lapsed = await insertDomain({ org_id: b, domain: 'taken.test', ownership_status: 'lapsed', send_account_id: acct.id, setup_mode: 'auto' })
    await db().updateTable('mail_domains').set({ provider_refs: jsonb({ send: { id: 'x' } }) }).where('id', '=', lapsed.id).execute()
    await h.mail.admin.deleteDomain({ orgId: b }, lapsed.id)
    expect(deprovisioned).toEqual([])
    await h.mail.admin.deleteDomain({ orgId: null }, domain.id)
    expect(deprovisioned).toEqual(['taken.test'])
  })

  it('the first domain on an account probes the account\'s key against it', async () => {
    const h = harness()
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    await h.mail.admin.addDomain({ orgId: null }, { domain: 'first.test', sendAccountId: acct.id }, BASE)
    expect((await h.mail.admin.getAccount({ orgId: null }, acct.id)).capabilities).toMatchObject({ send: true, suppressionLists: true })
    expect(h.fake.verifyCalls).toContainEqual({ domain: 'first.test' })
  })
})

describe('domain checks and the daily job', () => {
  it('a refused provider check records the capability and checks the role the manual way', async () => {
    const h = harness()
    const acct = await hostAccount()
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'refused.test', sendAccountId: acct.id }, BASE)
    h.fake.checkDomain = async () => {
      throw new ProviderPermissionError('domains')
    }
    const check = await h.mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    const send = check.roles.find(r => r.role === 'send')!
    expect(send.status).toBe('verified')
    expect(send.checks.map(c => c.key)).toContain('provider')
    expect((await h.mail.admin.getAccount({ orgId: null }, acct.id)).capabilities).toMatchObject({ domains: false })
  })

  it('the daily recheck covers manual and env domains without a provider send, and alerts when a role leaves verified for any state', async () => {
    const h = harness()
    await h.mail.syncEnvAccount()
    const acct = await hostAccount()
    const { domain: manual } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'daily.manual.test', sendAccountId: acct.id, setupMode: 'manual' }, BASE)
    const { domain: auto } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'daily.auto.test', sendAccountId: acct.id }, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, manual.id, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, auto.id, BASE)

    const alerts: unknown[] = []
    h.fake.verifyCalls.length = 0
    const sent = h.fake.sent.length
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect(alerts).toEqual([])
    expect(h.fake.verifyCalls).toEqual([])
    expect(h.fake.sent).toHaveLength(sent)
    expect((await h.mail.admin.getDomain({ orgId: null }, manual.id)).send_status).toBe('verified')

    // The stored key status: the account's key can no longer send.
    h.fake.control.domainStatus = 'pending'
    const caps = (await h.mail.admin.getAccount({ orgId: null }, acct.id)).capabilities
    await db().updateTable('mail_accounts').set({ capabilities: jsonb({ ...caps, send: false }) }).where('id', '=', acct.id).execute()
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect(h.fake.verifyCalls).toEqual([])
    expect(alerts).toEqual(expect.arrayContaining([
      { kind: 'role_lost', orgId: null, domain: 'daily.auto.test', role: 'send' },
      { kind: 'role_lost', orgId: null, domain: 'daily.manual.test', role: 'send' }
    ]))
    expect((await h.mail.admin.getDomain({ orgId: null }, auto.id)).send_status).toBe('pending')
  })

  it('a provider error that isn\'t a refusal keeps a verified role\'s status and records the error', async () => {
    const h = harness()
    const acct = await hostAccount()
    const { domain: auto } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'flaky.auto.test', sendAccountId: acct.id }, BASE)
    const { domain: manual } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'flaky.manual.test', sendAccountId: acct.id, setupMode: 'manual' }, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, auto.id, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, manual.id, BASE)

    h.fake.checkDomain = async () => {
      throw new Error('Fake responded 503')
    }
    const alerts: unknown[] = []
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect(alerts).toEqual([])
    expect(await h.mail.admin.getDomain({ orgId: null }, auto.id)).toMatchObject({ send_status: 'verified', send_error: 'Fake responded 503' })

    h.fake.verifyCredentials = async () => ({ ok: false, error: 'Fake responded 500', retryable: true })
    const check = await h.mail.admin.checkDomain({ orgId: null }, manual.id, BASE)
    expect(check.roles.find(r => r.role === 'send')).toMatchObject({ status: 'verified', error: 'Fake responded 500' })
    h.fake.verifyCredentials = async () => {
      throw new Error('socket hang up')
    }
    await h.mail.admin.checkDomain({ orgId: null }, manual.id, BASE)
    expect(await h.mail.admin.getDomain({ orgId: null }, manual.id)).toMatchObject({ send_status: 'verified', send_error: 'socket hang up' })

    // A refusal still fails the role.
    h.fake.verifyCredentials = async () => ({ ok: false, error: 'Unauthorized' })
    await h.mail.admin.checkDomain({ orgId: null }, manual.id, BASE)
    expect((await h.mail.admin.getDomain({ orgId: null }, manual.id)).send_status).toBe('failed')
  })

  it('the daily recheck of a manual receiving role checks its MX records and sends no probe', async () => {
    const h = harness()
    h.fake.receivesAt = exchange => exchange === 'mx.fake.example'
    const acct = await hostAccount()
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'in.manual.test', sendAccountId: acct.id, receiveAccountId: acct.id, setupMode: 'manual' }, BASE)
    await db().updateTable('mail_domains').set({ send_status: 'verified', receive_status: 'verified' }).where('id', '=', domain.id).execute()
    h.dns.records.set('in.manual.test', { mx: [{ exchange: 'mx.fake.example.', priority: 10 }] })
    const sent = h.fake.sent.length

    const alerts: unknown[] = []
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect(alerts).toEqual([])
    expect((await h.mail.admin.getDomain({ orgId: null }, domain.id)).receive_status).toBe('verified')

    h.dns.records.set('in.manual.test', { mx: [{ exchange: 'mx.elsewhere.test', priority: 10 }] })
    await h.mail.admin.runDailyJob({ baseUrl: BASE, onAlert: async a => void alerts.push(a) })
    expect(alerts).toEqual([{ kind: 'role_lost', orgId: null, domain: 'in.manual.test', role: 'receive' }])
    expect((await h.mail.admin.getDomain({ orgId: null }, domain.id)).receive_status).toBe('failed')

    // An unverified receiving role gets its probe only from Check.
    await h.mail.admin.runDailyJob({ baseUrl: BASE })
    expect(h.fake.sent).toHaveLength(sent)
    await h.mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    expect(h.fake.sent.map(m => m.to)).toEqual([expect.stringMatching(/^nx-probe-.*@in\.manual\.test$/)])
  })

  it('moving a domain onto an account that was never probed probes the account\'s key against it', async () => {
    const h = harness()
    const first = await hostAccount()
    const fresh = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k2' }) })
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'moving.test', sendAccountId: first.id }, BASE)
    h.fake.verifyCalls.length = 0
    await h.mail.admin.patchDomain({ orgId: null }, domain.id, { sendAccountId: fresh.id }, BASE)
    expect(h.fake.verifyCalls).toContainEqual({ domain: 'moving.test' })
    expect((await h.mail.admin.getAccount({ orgId: null }, fresh.id)).capabilities).toMatchObject({ send: true, suppressionLists: true })
  })

  it('a role moved to another account loses the old account\'s refs when its setup there falls back to manual', async () => {
    const h = harness()
    const first = await hostAccount()
    const other = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k2' }) })
    const { domain } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'refs.test', sendAccountId: first.id, receiveAccountId: first.id }, BASE)
    expect(Object.keys((await h.mail.admin.getDomain({ orgId: null }, domain.id)).provider_refs as object).sort()).toEqual(['receive', 'send'])

    const provision = h.fake.provisionDomain!
    h.fake.provisionDomain = async (creds, name, role, urls) => {
      if (role === 'send') throw new Error('Fake responded 400')
      return await provision(creds, name, role, urls)
    }
    const res = await h.mail.admin.patchDomain({ orgId: null }, domain.id, { sendAccountId: other.id }, BASE)
    expect(res.setup?.roles).toEqual([{ role: 'send', mode: 'manual', error: 'Fake responded 400' }, { role: 'receive', mode: 'auto' }])
    expect(res.domain.setup_mode).toBe('auto')
    expect(Object.keys(res.domain.provider_refs as object)).toEqual(['receive'])

    const checked: string[] = []
    h.fake.checkDomain = async (_c, _d, role) => {
      checked.push(role)
      return { status: 'verified', records: [] }
    }
    const check = await h.mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    expect(checked).toEqual(['receive'])
    expect(check.roles.find(r => r.role === 'send')!.checks.map(c => c.key)).toContain('provider')
  })

  it('inbound for a lapsed domain is dropped; once another org verifies the name, it reaches the new owner', async () => {
    const seen: (string | null)[] = []
    const h = harness({ inboundHandlers: [{ id: 'all', order: 1000, match: () => true, handle: async (_m, c) => {
      seen.push(c.domain.org_id)
      return 'handled'
    } }] })
    const acct = await hostAccount()
    const a = await orgId()
    const b = await orgId()
    const old = await insertDomain({ org_id: a, domain: 'moved.test', ownership_status: 'lapsed', send_account_id: acct.id, receive_account_id: acct.id, receive_status: 'verified' })
    const mail = { envelopeTo: ['hello@moved.test'] } as unknown as InboundMail
    expect((await h.mail.dispatchInbound(acct, mail)).outcome).toBe('dropped')

    const { domain: claim } = await h.mail.admin.addDomain({ orgId: b }, { domain: 'moved.test', sendAccountId: acct.id, receiveAccountId: acct.id }, BASE)
    txt(h, '_nx-verify.moved.test', `nx-verify=${claim.ownership_token}`)
    expect((await h.mail.admin.verifyOwnership({ orgId: b }, claim.id, BASE)).ok).toBe(true)
    expect(await db().selectFrom('mail_domains').select('id').where('id', '=', old.id).executeTakeFirst()).toBeUndefined()
    expect((await h.mail.dispatchInbound(acct, mail)).outcome).toBe('handled')
    expect(seen).toEqual([b])
  })
})

describe('webhook event lists', () => {
  const streams: MailStream[] = [
    { id: 'system', label: 'System', defaultLocal: 'noreply', orgAssignable: false },
    { id: 'account', label: 'Account', defaultLocal: 'noreply', orgAssignable: false, userInitiated: true },
    { id: 'newsletter', label: 'Newsletter', defaultLocal: 'news', orgAssignable: true, bulk: true }
  ]

  it('moving a stream updates the webhooks of the domain it falls back to', async () => {
    const h = harness({ env: {}, streams })
    const acct = await hostAccount()
    const { domain: fallback } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'fallback.test', sendAccountId: acct.id, makeDefault: true }, BASE)
    const { domain: own } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'account.test', sendAccountId: acct.id }, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, own.id, BASE)
    await h.mail.admin.setStreamRoute({ orgId: null }, 'account', own.id, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, fallback.id, BASE)
    expect(h.fake.webhooksConfigured.filter(w => w.domain === 'fallback.test').at(-1)!.events).not.toContain('delivered')

    await h.mail.admin.setStreamRoute({ orgId: null }, 'account', null, BASE)
    expect(h.fake.webhooksConfigured.filter(w => w.domain === 'fallback.test').at(-1)!.events).toContain('delivered')
    expect((await h.mail.admin.webhookStatus(await h.mail.admin.getDomain({ orgId: null }, fallback.id))).state).toBe('connected')
  })

  it('a route change doesn\'t reconfigure the webhooks of a domain that isn\'t ownership-verified', async () => {
    const h = harness({ env: {}, streams })
    const acct = await hostAccount()
    const org = await orgId()
    const lapsed = await insertDomain({ org_id: org, domain: 'lapsed.route.test', ownership_status: 'lapsed', send_account_id: acct.id, setup_mode: 'auto' })
    await db().updateTable('mail_domains').set({ webhook_events: jsonb(['bounced']), provider_refs: jsonb({ send: { id: 'x' } }) }).where('id', '=', lapsed.id).execute()
    await route(org, '*', lapsed.id)
    await h.mail.admin.setStreamRoute({ orgId: org }, '*', null, BASE)
    expect(h.fake.webhooksConfigured).toEqual([])
  })

  it('with an account-level webhook, the event list spans the account\'s domains and a bulk stream on any of them warns', async () => {
    const h = harness({ env: {}, streams })
    h.fake.webhookScope = 'account'
    const acct = await hostAccount()
    const { domain: bulk } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'bulk.acct.test', sendAccountId: acct.id }, BASE)
    const { domain: account } = await h.mail.admin.addDomain({ orgId: null }, { domain: 'account.acct.test', sendAccountId: acct.id }, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, bulk.id, BASE)
    await h.mail.admin.checkDomain({ orgId: null }, account.id, BASE)
    await route(null, 'newsletter', bulk.id)
    await route(null, 'account', account.id)

    const bulkRow = await h.mail.admin.getDomain({ orgId: null }, bulk.id)
    expect(await h.mail.admin.requiredEvents(bulkRow)).not.toContain('delivered')
    expect(await h.mail.admin.postedEvents(bulkRow)).toContain('delivered')
    const steps = h.mail.admin.manualSteps(acct, bulkRow, 'send', h.mail.webhookUrls(acct, BASE), await h.mail.admin.postedEvents(bulkRow))
    expect(steps.map(s => s.detail).join(' ')).toContain('delivered')

    const overview = await h.mail.admin.streamsOverview({ orgId: null })
    expect(overview.streams.find(s => s.id === 'newsletter')!.bulkWarning).toBe(true)
  })
})
