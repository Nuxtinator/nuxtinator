import { sql } from 'kysely'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { addressHash, encryptJson, type MailAccountRow, type MailEvent, type MailEventHandler } from '../kernel'
import { fakeSignature } from '../test'
import { db, harness, insertAccount, insertDomain, mailFor, orgId, resetTables, route, SECRET } from './helpers'

beforeEach(resetTables)
afterAll(async () => {
  await db().destroy()
})

const rows = () => db().selectFrom('mail_suppressions').selectAll().orderBy('created_at').execute()

function event(e: Partial<MailEvent> & Pick<MailEvent, 'type' | 'recipient'>): MailEvent {
  return { permanent: false, providerMessageId: null, occurredAt: new Date(), detail: null, stream: null, orgId: null, ref: null, ...e }
}

async function hostAccount(): Promise<MailAccountRow> {
  return await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k', signingKey: 'sig' }), capabilities: JSON.stringify({ suppressionLists: true }) })
}

describe('events → suppressions', () => {
  it('host account: a bounce suppresses globally; a complaint with nx-org=A suppresses org A only', async () => {
    const { mail } = harness()
    const acct = await hostAccount()
    const a = await orgId()
    await mail.handleEvents(acct, [
      event({ type: 'bounced', permanent: true, recipient: 'b@x.test' }),
      event({ type: 'complained', recipient: 'c@x.test', orgId: a })
    ])
    expect((await rows()).map(r => [r.reason, r.scope, r.org_id])).toEqual([['hard_bounce', 'global', null], ['complaint', 'org', a]])
    expect(await mail.isSuppressed('c@x.test', { orgId: a })).toBeTruthy()
    expect(await mail.isSuppressed('c@x.test')).toBe(false)
  })

  it('a temporary bounce or deferral suppresses nothing', async () => {
    const { mail } = harness()
    const acct = await hostAccount()
    await mail.handleEvents(acct, [event({ type: 'bounced', permanent: false, recipient: 't@x.test' }), event({ type: 'deferred', recipient: 't@x.test' })])
    expect(await rows()).toHaveLength(0)
  })

  it('org-owned account: bounces are org-scoped, forged nx-org is ignored, delivered can\'t clear a global bounce', async () => {
    const { mail } = harness()
    const a = await orgId()
    const b = await orgId()
    const orgAcct = await insertAccount({ org_id: a, credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const host = await hostAccount()
    await mail.handleEvents(host, [event({ type: 'bounced', permanent: true, recipient: 'g@x.test' })])
    await mail.handleEvents(orgAcct, [
      event({ type: 'bounced', permanent: true, recipient: 'o@x.test' }),
      event({ type: 'complained', recipient: 'f@x.test', orgId: b }),
      event({ type: 'delivered', recipient: 'g@x.test' })
    ])
    const all = await rows()
    expect(all.find(r => r.address_hash === addressHash('o@x.test'))).toMatchObject({ scope: 'org', org_id: a })
    expect(all.find(r => r.address_hash === addressHash('f@x.test'))).toMatchObject({ scope: 'org', org_id: a })
    expect(all.find(r => r.address_hash === addressHash('g@x.test'))!.cleared_at).toBeNull()
  })

  it('delivered on a host account clears the hard bounce, leaves complaints, and a repeat writes nothing new', async () => {
    const { mail } = harness()
    const acct = await hostAccount()
    const earlier = new Date(Date.now() - 60_000)
    await mail.handleEvents(acct, [
      event({ type: 'bounced', permanent: true, recipient: 'd@x.test', occurredAt: earlier }),
      event({ type: 'bounced', permanent: true, recipient: 'd@x.test', occurredAt: earlier }),
      event({ type: 'complained', recipient: 'd@x.test', occurredAt: earlier })
    ])
    expect(await rows()).toHaveLength(2)
    await mail.handleEvents(acct, [event({ type: 'delivered', recipient: 'd@x.test' })])
    const after = await rows()
    expect(after.find(r => r.reason === 'hard_bounce')).toMatchObject({ cleared_reason: 'delivered' })
    expect(after.find(r => r.reason === 'complaint')!.cleared_at).toBeNull()
  })

  it('a delivered event older than the bounce clears nothing', async () => {
    const { mail } = harness()
    const acct = await hostAccount()
    await mail.handleEvents(acct, [event({ type: 'bounced', permanent: true, recipient: 'l@x.test' })])
    await mail.handleEvents(acct, [event({ type: 'delivered', recipient: 'l@x.test', occurredAt: new Date(Date.now() - 3600_000) })])
    expect((await rows())[0]!.cleared_at).toBeNull()
  })

  it('a complaint during an active bounce is its own row and survives the bounce being cleared', async () => {
    const { mail } = harness()
    const acct = await hostAccount()
    await mail.handleEvents(acct, [event({ type: 'bounced', permanent: true, recipient: 'cb@x.test', occurredAt: new Date(Date.now() - 1000) })])
    await mail.handleEvents(acct, [event({ type: 'complained', recipient: 'cb@x.test' })])
    await mail.handleEvents(acct, [event({ type: 'delivered', recipient: 'cb@x.test', occurredAt: new Date(Date.now() + 1000) })])
    expect(await mail.isSuppressed('cb@x.test')).toEqual({ reason: 'complaint', scope: 'host' })
  })

  it('handlers see the account\'s org on an org-owned account', async () => {
    const seen: (string | null)[] = []
    const handler: MailEventHandler = { id: 'h', handle: async e => void seen.push(e.orgId) }
    const { mail } = harness({ eventHandlers: [handler] })
    const a = await orgId()
    const b = await orgId()
    const orgAcct = await insertAccount({ org_id: a, credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    await mail.handleEvents(orgAcct, [event({ type: 'delivered', recipient: 'x@x.test', orgId: b, ref: 'm1' })])
    const host = await hostAccount()
    await mail.handleEvents(host, [event({ type: 'delivered', recipient: 'x@x.test', orgId: b })])
    expect(seen).toEqual([a, b])
  })

  it('handlers filter by stream and type; probe events are ignored', async () => {
    const seen: string[] = []
    const { mail } = harness({
      eventHandlers: [{ id: 'inbox', stream: 'inbox', types: ['delivered'], handle: async e => void seen.push(`${e.type}:${e.ref}`) }]
    })
    const acct = await hostAccount()
    await mail.handleEvents(acct, [
      event({ type: 'delivered', recipient: 'a@x.test', stream: 'inbox', ref: 'r1' }),
      event({ type: 'bounced', recipient: 'a@x.test', stream: 'inbox', ref: 'r2' }),
      event({ type: 'delivered', recipient: 'a@x.test', stream: 'system', ref: 'r3' }),
      event({ type: 'bounced', permanent: true, recipient: 'probe@x.test', stream: 'nx-probe' })
    ])
    expect(seen).toEqual(['delivered:r1'])
    expect(await rows()).toHaveLength(0)
  })

  it('a drop from the provider\'s unsubscribe list imports nothing, releases on a mirrored domain, and reaches handlers', async () => {
    const seen: string[] = []
    const { mail, fake } = harness({ eventHandlers: [{ id: 'h', handle: async e => void seen.push(e.type) }] })
    const acct = await hostAccount()
    await insertDomain({ domain: 'm.example.net', send_account_id: acct.id })
    await mail.handleEvents(acct, [event({ type: 'dropped', list: 'unsubscribe', recipient: 'u@x.test', domain: 'm.example.net' })])
    expect(await rows()).toHaveLength(0)
    expect(fake.released).toEqual([{ domain: 'm.example.net', address: 'u@x.test', list: 'unsubscribe' }])
    expect(seen).toEqual(['dropped'])
  })

  it('dropped: imports when the kernel has no record, releases when its record is cleared', async () => {
    const { mail, fake } = harness()
    const acct = await hostAccount()
    await insertDomain({ domain: 'm.example.net', send_account_id: acct.id })
    await mail.handleEvents(acct, [event({ type: 'dropped', list: 'bounce', recipient: 'n@x.test', domain: 'm.example.net' })])
    expect((await rows()).map(r => [r.reason, r.scope])).toEqual([['hard_bounce', 'global']])
    expect(fake.released).toHaveLength(0)

    await db().updateTable('mail_suppressions').set({ cleared_at: new Date(), cleared_reason: 'admin' }).execute()
    await mail.handleEvents(acct, [event({ type: 'dropped', list: 'bounce', recipient: 'n@x.test', domain: 'm.example.net' })])
    expect(await rows()).toHaveLength(1)
    expect(fake.released).toEqual([{ domain: 'm.example.net', address: 'n@x.test', list: 'bounce' }])
  })

  it('a complaint releases the provider\'s complaint entry on a mirrored domain', async () => {
    const { mail, fake } = harness()
    const acct = await hostAccount()
    await insertDomain({ domain: 'm.example.net', send_account_id: acct.id })
    await mail.handleEvents(acct, [event({ type: 'complained', recipient: 'c@x.test', domain: 'm.example.net' })])
    expect(fake.released).toEqual([{ domain: 'm.example.net', address: 'c@x.test', list: 'complaint' }])
  })

  it('a userInitiated send to a hard-bounced address releases first on mirrored, not on unmanaged', async () => {
    const acct = await hostAccount()
    const domain = await insertDomain({ domain: 'm.example.net', send_account_id: acct.id })
    await route(null, '*', domain.id)
    await db().insertInto('mail_suppressions').values({ address_hash: addressHash('hb@x.test'), scope: 'global', reason: 'hard_bounce', occurred_at: new Date() }).execute()
    const { mail, fake } = harness({ env: {} })
    expect((await mail.send(mailFor('hb@x.test', { stream: 'account' }))).status).toBe('sent')
    expect(fake.released).toEqual([{ domain: 'm.example.net', address: 'hb@x.test', list: 'bounce' }])
    expect(fake.sent[0]!.bypassProviderSuppression).toBe(true)

    fake.reset()
    fake.control.deliver = false
    fake.control.mode = 'unmanaged'
    expect((await mail.send(mailFor('hb@x.test', { stream: 'account' }))).status).toBe('sent')
    expect(fake.released).toHaveLength(0)
  })
})

describe('one address, one scope', () => {
  it('an active hard bounce and complaint in one scope are two rows; send reports the complaint, and clearing the bounce leaves it', async () => {
    const { mail } = harness({ env: {} })
    const a = await orgId()
    const orgAcct = await insertAccount({ org_id: a, credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const domain = await insertDomain({ org_id: a, domain: 'org-a.example.net', send_account_id: orgAcct.id })
    await route(a, '*', domain.id)
    const earlier = new Date(Date.now() - 60_000)
    await mail.handleEvents(orgAcct, [
      event({ type: 'bounced', permanent: true, recipient: 'same@x.test', occurredAt: earlier }),
      event({ type: 'complained', recipient: 'same@x.test', occurredAt: earlier })
    ])
    const active = await rows()
    expect(active.map(r => [r.reason, r.scope, r.org_id])).toEqual([['hard_bounce', 'org', a], ['complaint', 'org', a]])

    expect(await mail.send(mailFor('same@x.test', { stream: 'newsletter', orgId: a }))).toEqual({ status: 'suppressed', reason: 'complaint' })

    await mail.admin.clearSuppression({ orgId: a }, active.find(r => r.reason === 'hard_bounce')!.id)
    expect(await mail.isSuppressed('same@x.test', { orgId: a })).toEqual({ reason: 'complaint', scope: 'org' })
    expect(await mail.send(mailFor('same@x.test', { stream: 'newsletter', orgId: a }))).toEqual({ status: 'suppressed', reason: 'complaint' })
  })
})

describe('events that name no domain, or no live org', () => {
  it('an event without a domain releases on each mirrored domain of the account, by that domain\'s own capabilities', async () => {
    const { mail, fake } = harness()
    const acct = await hostAccount()
    await insertDomain({ domain: 'one.example.net', send_account_id: acct.id })
    await insertDomain({ domain: 'two.example.net', send_account_id: acct.id })
    await insertDomain({ domain: 'own-key.example.net', send_account_id: acct.id, capabilities: JSON.stringify({ send: true, suppressionLists: false }) })
    const other = await hostAccount()
    await insertDomain({ domain: 'other-account.example.net', send_account_id: other.id })
    await mail.handleEvents(acct, [event({ type: 'complained', recipient: 'c@x.test' })])
    expect(fake.released.map(r => r.domain).sort()).toEqual(['one.example.net', 'two.example.net'])
  })

  it('an event naming the From domain finds the sending domain behind it', async () => {
    const { mail, fake } = harness()
    const acct = await hostAccount()
    await insertDomain({ domain: 'mg.example.net', from_domain: 'example.net', send_account_id: acct.id })
    await insertDomain({ domain: 'news.example.net', send_account_id: acct.id })
    await mail.handleEvents(acct, [event({ type: 'complained', recipient: 'c@x.test', domain: 'example.net' })])
    expect(fake.released).toEqual([{ domain: 'mg.example.net', address: 'c@x.test', list: 'complaint' }])
  })

  it('a complaint for an org that no longer exists is skipped, and the rest of the batch is applied', async () => {
    await db().schema.createTable('events_test_orgs').ifNotExists().addColumn('id', 'uuid', c => c.primaryKey()).execute()
    await sql`ALTER TABLE mail_suppressions ADD CONSTRAINT events_test_org_fk FOREIGN KEY (org_id) REFERENCES events_test_orgs(id)`.execute(db())
    try {
      const seen: (string | null)[] = []
      const { mail } = harness({ eventHandlers: [{ id: 'h', handle: async e => void seen.push(e.orgId) }] })
      const acct = await hostAccount()
      const gone = await orgId()
      await mail.handleEvents(acct, [
        event({ type: 'complained', recipient: 'gone@x.test', orgId: gone }),
        event({ type: 'bounced', permanent: true, recipient: 'next@x.test' })
      ])
      expect((await rows()).map(r => [r.reason, r.scope])).toEqual([['hard_bounce', 'global']])
      expect(seen).toEqual([gone, null])
    } finally {
      await sql`ALTER TABLE mail_suppressions DROP CONSTRAINT events_test_org_fk`.execute(db())
      await db().schema.dropTable('events_test_orgs').execute()
    }
  })

  it('a correlation org that isn\'t a uuid is ignored', async () => {
    const seen: (string | null)[] = []
    const { mail } = harness({ eventHandlers: [{ id: 'h', handle: async e => void seen.push(e.orgId) }] })
    const acct = await hostAccount()
    await mail.handleEvents(acct, [event({ type: 'complained', recipient: 'odd@x.test', orgId: 'not-a-uuid' })])
    expect((await rows()).map(r => [r.reason, r.scope, r.org_id])).toEqual([['complaint', 'host', null]])
    expect(seen).toEqual([null])
  })
})

describe('a delivery that clears a bounce', () => {
  it('host account: releases the bounce from the other mirrored domains\' lists', async () => {
    const { mail, fake } = harness()
    const acct = await hostAccount()
    await insertDomain({ domain: 'a.example.net', send_account_id: acct.id })
    await insertDomain({ domain: 'b.example.net', send_account_id: acct.id })
    const org = await orgId()
    const orgAcct = await insertAccount({ org_id: org, credentials: encryptJson(SECRET, { apiKey: 'k' }), capabilities: JSON.stringify({ suppressionLists: true }) })
    await insertDomain({ org_id: org, domain: 'org.example.net', send_account_id: orgAcct.id })
    await mail.handleEvents(acct, [event({ type: 'bounced', permanent: true, recipient: 'back@x.test', occurredAt: new Date(Date.now() - 1000) })])
    await mail.handleEvents(acct, [event({ type: 'delivered', recipient: 'back@x.test', domain: 'a.example.net' })])
    expect(fake.released.map(r => [r.domain, r.list]).sort()).toEqual([['b.example.net', 'bounce'], ['org.example.net', 'bounce']])

    fake.released.length = 0
    await mail.handleEvents(acct, [event({ type: 'delivered', recipient: 'back@x.test', domain: 'a.example.net' })])
    expect(fake.released).toEqual([])
  })

  it('org-owned account: releases only on that org\'s own accounts', async () => {
    const { mail, fake } = harness()
    const host = await hostAccount()
    await insertDomain({ domain: 'host.example.net', send_account_id: host.id })
    const org = await orgId()
    const orgAcct = await insertAccount({ org_id: org, credentials: encryptJson(SECRET, { apiKey: 'k' }), capabilities: JSON.stringify({ suppressionLists: true }) })
    await insertDomain({ org_id: org, domain: 'one.org.example.net', send_account_id: orgAcct.id })
    await insertDomain({ org_id: org, domain: 'two.org.example.net', send_account_id: orgAcct.id })
    await mail.handleEvents(orgAcct, [event({ type: 'bounced', permanent: true, recipient: 'o@x.test', occurredAt: new Date(Date.now() - 1000) })])
    await mail.handleEvents(orgAcct, [event({ type: 'delivered', recipient: 'o@x.test' })])
    expect(fake.released.map(r => r.domain).sort()).toEqual(['one.org.example.net', 'two.org.example.net'])
  })
})

describe('clearing a suppression by hand', () => {
  it('without the address the provider lists are reported untouched; with it they are released', async () => {
    const { mail, fake } = harness()
    const acct = await hostAccount()
    await insertDomain({ domain: 'm.example.net', send_account_id: acct.id })
    await insertDomain({ domain: 'u.example.net', send_account_id: acct.id, capabilities: JSON.stringify({ send: true, suppressionLists: false }) })
    await mail.handleEvents(acct, [event({ type: 'bounced', permanent: true, recipient: 'h@x.test' })])
    const [row] = await rows()
    const plain = await mail.admin.clearSuppression({ orgId: null }, row!.id)
    expect(plain.providerLists).toEqual({ released: [], notReleased: ['m.example.net'] })
    expect(plain.address).toBeUndefined()
    expect(fake.released).toEqual([])

    await mail.handleEvents(acct, [event({ type: 'bounced', permanent: true, recipient: 'h@x.test' })])
    const again = (await rows()).find(r => !r.cleared_at)!
    const withAddress = await mail.admin.clearSuppression({ orgId: null }, again.id, 'H@x.test')
    expect(withAddress.providerLists).toEqual({ released: ['m.example.net'], notReleased: [] })
    expect(fake.released).toEqual([{ domain: 'm.example.net', address: 'H@x.test', list: 'bounce' }])
  })
})

describe('webhooks and inbound', () => {
  const RAW = (to: string) => Buffer.from([
    'From: Sender <sender@remote.test>',
    `To: ${to}`,
    'Subject: Hi',
    'Message-ID: <abc@remote.test>',
    'Authentication-Results: mx.test; dkim=pass header.d=remote.test; spf=pass; dmarc=pass',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'Hello there',
    '--b',
    'Content-Type: image/png',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-ID: <logo@x>',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--b--',
    ''
  ].join('\r\n'))

  async function setup(handlers: Parameters<typeof harness>[0] = {}) {
    const h = harness(handlers)
    const acct = await hostAccount()
    const token = h.mail.webhookToken(acct)
    return { ...h, acct, token }
  }

  function post(h: Awaited<ReturnType<typeof setup>>, kind: 'events' | 'inbound', body: Buffer, headers: Record<string, string> = {}, token = h.token, signingKey = 'sig') {
    return h.mail.handleWebhook({
      accountId: h.acct.id,
      token,
      kind,
      headers: { 'x-fake-signature': fakeSignature(signingKey, body), ...headers },
      rawBody: body
    })
  }

  it('a wrong token → 404; a bad signature → 401; an old token version → 404', async () => {
    const h = await setup()
    const body = Buffer.from(JSON.stringify({ events: [] }))
    expect((await post(h, 'events', body, {}, 'nope')).status).toBe(404)
    expect((await post(h, 'events', body, {}, h.token, 'wrong')).status).toBe(401)
    expect((await post(h, 'events', body)).status).toBe(200)
    await db().updateTable('mail_accounts').set({ webhook_token_version: 2 }).where('id', '=', h.acct.id).execute()
    expect((await post(h, 'events', body)).status).toBe(404)
  })

  it('parses raw MIME with attachments, inline cids, envelope and DMARC', async () => {
    const seen: unknown[] = []
    const h = await setup({ inboundHandlers: [{ id: 'all', order: 1000, match: () => true, handle: async (m) => { seen.push(m); return 'handled' } }] })
    await insertDomain({ domain: 'in.example.net', receive_account_id: h.acct.id, receive_status: 'verified' })
    const res = await post(h, 'inbound', RAW('Contact <contact@in.example.net>'), { 'x-fake-envelope-to': 'contact@in.example.net' })
    expect(res.status).toBe(200)
    const m = seen[0] as import('../kernel').InboundMail
    expect(m.envelopeTo).toEqual(['contact@in.example.net'])
    expect(m.from).toEqual({ address: 'sender@remote.test', name: 'Sender' })
    expect(m.messageId).toBe('<abc@remote.test>')
    expect(m.authentication.dmarc).toBe('pass')
    expect(m.attachments[0]).toMatchObject({ filename: 'logo.png', cid: 'logo@x', inline: true })
  })

  it('unknown domain or a different receiving account → 200 and dropped', async () => {
    const calls: string[] = []
    const h = await setup({ inboundHandlers: [{ id: 'all', order: 1000, match: () => true, handle: async (_m, c) => { calls.push(c.recipient.address); return 'handled' } }] })
    const other = await hostAccount()
    await insertDomain({ domain: 'other.example.net', receive_account_id: other.id, receive_status: 'verified' })
    const r1 = await post(h, 'inbound', RAW('a@unknown.test'), { 'x-fake-envelope-to': 'a@unknown.test' })
    const r2 = await post(h, 'inbound', RAW('a@other.example.net'), { 'x-fake-envelope-to': 'a@other.example.net' })
    expect([r1.status, r2.status]).toEqual([200, 200])
    expect(calls).toEqual([])
  })

  it('dispatches once per receiving domain; one retry → 503; order decides', async () => {
    const calls: string[] = []
    let retry = false
    const h = await setup({
      inboundHandlers: [
        { id: 'catch-all', order: 1000, match: () => true, handle: async (_m, c) => { calls.push(`all:${c.recipient.address}`); return retry ? 'retry' : 'handled' } },
        { id: 'unsub', order: 10, match: c => c.recipient.local.startsWith('unsubscribe+'), handle: async (_m, c) => { calls.push(`unsub:${c.recipient.address}`); return 'handled' } }
      ]
    })
    await insertDomain({ domain: 'one.example.net', receive_account_id: h.acct.id, receive_status: 'verified' })
    await insertDomain({ domain: 'two.example.net', receive_account_id: h.acct.id, receive_status: 'verified' })
    const env = { 'x-fake-envelope-to': 'a@one.example.net, unsubscribe+x@two.example.net' }
    expect((await post(h, 'inbound', RAW('a@one.example.net'), env)).status).toBe(200)
    expect(calls).toEqual(['all:a@one.example.net', 'unsub:unsubscribe+x@two.example.net'])
    retry = true
    expect((await post(h, 'inbound', RAW('a@one.example.net'), env)).status).toBe(503)
  })

  it('the probe handler verifies receiving only for the exact current token', async () => {
    const h = await setup()
    const d = await insertDomain({ domain: 'p.example.net', receive_account_id: h.acct.id, probe_token: 'tok123' })
    await post(h, 'inbound', RAW('x'), { 'x-fake-envelope-to': 'nx-probe-wrong@p.example.net' })
    expect((await db().selectFrom('mail_domains').select('receive_status').where('id', '=', d.id).executeTakeFirstOrThrow()).receive_status).toBe('pending')
    await post(h, 'inbound', RAW('x'), { 'x-fake-envelope-to': 'nx-probe-tok123@p.example.net' })
    expect((await db().selectFrom('mail_domains').select('receive_status').where('id', '=', d.id).executeTakeFirstOrThrow()).receive_status).toBe('verified')
  })

  it('a pending or lapsed domain receives nothing', async () => {
    const calls: string[] = []
    const h = await setup({ inboundHandlers: [{ id: 'all', order: 1000, match: () => true, handle: async () => { calls.push('x'); return 'handled' } }] })
    const org = await orgId()
    await insertDomain({ org_id: org, domain: 'lapsed.example.net', ownership_status: 'lapsed', receive_account_id: h.acct.id, receive_status: 'verified' })
    await post(h, 'inbound', RAW('a@lapsed.example.net'), { 'x-fake-envelope-to': 'a@lapsed.example.net' })
    expect(calls).toEqual([])
  })
})
