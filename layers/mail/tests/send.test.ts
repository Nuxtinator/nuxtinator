import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'
import { __setEndpointCheck } from '../adapters/http'
import { mailgunProvider } from '../adapters/mailgun'
import { createMail, decryptJson, encryptJson, notSuppressed, addressHash } from '../kernel'
import { createFakeProvider } from '../test'
import {
  db, ENV, harness, insertAccount, insertDomain, mailFor, orgId, OTHER_SECRET, queries, resetTables, route, SECRET, STREAMS
} from './helpers'

beforeEach(resetTables)
afterAll(async () => {
  await db().destroy()
})

describe('createMail', () => {
  it('reads the env account when createMail runs', async () => {
    const env: Record<string, string | undefined> = { ...ENV }
    const { mail: first } = harness({ env })
    await first.syncEnvAccount()
    env.MAIL_DOMAIN = 'other.example.org'
    const { mail: second } = harness({ env })
    await second.syncEnvAccount()
    const domains = await db().selectFrom('mail_domains').select('domain').execute()
    expect(domains.map(d => d.domain)).toEqual(['other.example.org'])
  })

  it('throws on an unregistered MAIL_PROVIDER and on duplicate ids', () => {
    expect(() => harness({ env: { ...ENV, MAIL_PROVIDER: 'nope' } })).toThrow(/nope/)
    expect(() => harness({ streams: [...STREAMS, STREAMS[0]!] })).toThrow(/share the id/)
    const fake = createFakeProvider()
    expect(() => harness({ fake, providers: [fake, createFakeProvider()] })).toThrow(/share the id/)
  })

  it('works from a bare Kysely instance with no Nuxt', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    const res = await mail.send(mailFor('a@x.test'))
    expect(res.status).toBe('sent')
    expect(fake.sent).toHaveLength(1)
  })
})

describe('env account', () => {
  it('upserts one account and one send-only domain, idempotently', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    await mail.syncEnvAccount()
    const accounts = await db().selectFrom('mail_accounts').selectAll().execute()
    const domains = await db().selectFrom('mail_domains').selectAll().execute()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ source: 'env', provider: 'fake', credentials: null, label: null })
    expect(domains).toHaveLength(1)
    expect(domains[0]).toMatchObject({ source: 'env', domain: 'mg.example.org', send_status: 'verified', receive_account_id: null, ownership_status: 'verified', setup_mode: 'manual' })
  })

  it('sends the first mail on a fresh database, and a 401 flips the domain until the next sync', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    expect((await mail.send(mailFor('a@x.test'))).status).toBe('sent')

    fake.control.nextResults.push({ status: 'failed', retryable: false, error: '401', keyRejected: true })
    const res = await mail.send(mailFor('a@x.test'))
    expect(res).toMatchObject({ status: 'failed', retryable: false })
    const domain = await db().selectFrom('mail_domains').selectAll().executeTakeFirstOrThrow()
    expect(domain).toMatchObject({ send_status: 'failed', send_error: 'key_rejected' })
    expect((await mail.send(mailFor('a@x.test'))).status).toBe('no_sender')

    await mail.syncEnvAccount()
    expect((await mail.send(mailFor('a@x.test'))).status).toBe('sent')
  })

  it('stores a NULL provider when only MAIL_DOMAIN is set, sending only under smtp and log', async () => {
    const env = { MAIL_DOMAIN: 'local.test' }
    const logged: string[] = []
    const { mail } = harness({ env, transport: 'log', log: l => logged.push(l) })
    await mail.syncEnvAccount()
    const account = await db().selectFrom('mail_accounts').selectAll().executeTakeFirstOrThrow()
    expect(account.provider).toBeNull()
    expect((await mail.send(mailFor('a@x.test'))).status).toBe('sent')
    expect(logged.some(l => l.includes('a@x.test'))).toBe(true)

    const { mail: viaSmtp, fake } = harness({ env, transport: { smtp: { host: '127.0.0.1', port: 1025 } } })
    expect((await viaSmtp.send(mailFor('smtp@x.test'))).status).toBe('sent')
    expect(fake.sent).toHaveLength(0)

    const { mail: viaProvider } = harness({ env, transport: 'provider' })
    const res = await viaProvider.send(mailFor('a@x.test'))
    expect(res).toMatchObject({ status: 'failed', retryable: false })
    expect((res as { error: string }).error).toMatch(/no provider/)
  })

  it('MAILGUN_API_KEY and MAILGUN_DOMAIN alone: the first send goes out From SMTP_FROM; a 401 flips the domain until the next sync', async () => {
    const seen: { path: string, body: string }[] = []
    let status = 200
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status === 200 ? { id: '<mg-1@mg.example.org>', message: 'Queued' } : { message: 'Forbidden' }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    __setEndpointCheck(url => url.hostname === '127.0.0.1')
    try {
      const env = {
        MAILGUN_API_KEY: 'key-mg',
        MAILGUN_DOMAIN: 'mg.example.org',
        MAILGUN_HOST: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        SMTP_FROM: 'noreply@example.org'
      }
      const app = () => createMail({ db: db(), providers: [mailgunProvider], streams: STREAMS, env, secretKey: SECRET, transport: 'provider', log: () => {} })
      const mail = app()
      await mail.syncEnvAccount()
      const account = await db().selectFrom('mail_accounts').selectAll().executeTakeFirstOrThrow()
      expect(account.provider).toBe('mailgun')
      const domain = await db().selectFrom('mail_domains').selectAll().executeTakeFirstOrThrow()
      expect(domain).toMatchObject({ domain: 'mg.example.org', from_domain: 'example.org' })

      expect(await mail.send(mailFor('a@x.test'))).toMatchObject({ status: 'sent', domain: 'mg.example.org', providerMessageId: '<mg-1@mg.example.org>' })
      expect(seen[0]!.path).toBe('/v3/mg.example.org/messages')
      expect(seen[0]!.body).toContain('noreply@example.org')
      expect(seen[0]!.body).not.toContain('noreply@mg.example.org')

      status = 401
      expect(await mail.send(mailFor('a@x.test'))).toMatchObject({ status: 'failed', retryable: false })
      expect(await db().selectFrom('mail_domains').select(['send_status', 'send_error']).executeTakeFirstOrThrow())
        .toEqual({ send_status: 'failed', send_error: 'key_rejected' })
      expect((await mail.send(mailFor('a@x.test'))).status).toBe('no_sender')

      status = 200
      await app().syncEnvAccount()
      expect((await mail.send(mailFor('a@x.test'))).status).toBe('sent')
    } finally {
      __setEndpointCheck(null)
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('a MAIL_DOMAIN change to a name a host admin already added takes that name over', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const ui = await insertDomain({ domain: 'taken.example.org', send_account_id: acct.id })
    await route(null, '*', ui.id)

    const { mail: moved } = harness({ env: { ...ENV, MAIL_DOMAIN: 'Taken.example.org' } })
    await moved.syncEnvAccount()
    const rows = await db().selectFrom('mail_domains').select(['domain', 'source']).execute()
    expect(rows).toEqual([{ domain: 'taken.example.org', source: 'env' }])
  })

  it('the env domain takes a name an org has verified or claimed', async () => {
    const org = await orgId()
    const other = await orgId()
    const acct = await insertAccount({ org_id: org, credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    await insertDomain({ org_id: org, domain: 'mg.example.org', send_account_id: acct.id })
    await insertDomain({ org_id: other, domain: 'MG.example.org', ownership_status: 'pending' })

    const { mail } = harness()
    await mail.syncEnvAccount()
    const rows = await db().selectFrom('mail_domains').select(['domain', 'source', 'org_id']).execute()
    expect(rows).toEqual([{ domain: 'mg.example.org', source: 'env', org_id: null }])

    // A later sync, after an org claimed the name again, also clears the claim.
    await insertDomain({ org_id: other, domain: 'mg.example.org', ownership_status: 'pending' })
    await mail.syncEnvAccount()
    expect(await db().selectFrom('mail_domains').select('source').execute()).toEqual([{ source: 'env' }])
  })

  it('removed env vars: sends through the env rows fail clearly and queued rows fail at once', async () => {
    const { mail: before } = harness()
    await before.syncEnvAccount()
    const { mail: worker } = harness({ env: {} })

    const { mail, fake } = harness({ env: {} })
    await mail.syncEnvAccount()
    const res = await mail.send(mailFor('a@x.test'))
    expect(res).toMatchObject({ status: 'failed', retryable: false })
    expect((res as { error: string }).error).toMatch(/no longer set/)
    expect(await mail.send(mailFor('q@x.test', { stream: 'queued' }))).toMatchObject({ status: 'failed', retryable: false })
    expect(await db().selectFrom('mail_outbox').select(['status', 'last_error']).executeTakeFirstOrThrow())
      .toMatchObject({ status: 'failed', last_error: expect.stringMatching(/no longer set/) })
    expect(fake.sent).toHaveLength(0)

    // A process missing the vars while the app still records them pauses instead.
    await before.syncEnvAccount()
    expect(await worker.envAccountStatus()).toBe('mismatch')
    expect(await worker.send(mailFor('a@x.test'))).toMatchObject({ status: 'failed', retryable: true })
  })

  it('uses from_domain for the From address', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    const domain = await db().selectFrom('mail_domains').selectAll().executeTakeFirstOrThrow()
    expect(domain.from_domain).toBe('example.org')
    await mail.send(mailFor('a@x.test'))
    expect(fake.sent[0]!.from.address).toBe('noreply@example.org')
    expect(fake.sent[0]!.domain).toBe('mg.example.org')
  })

  it('pauses env-account sends in a process whose env differs, without blocking boot', async () => {
    const { mail: app } = harness()
    await app.syncEnvAccount()
    const ui = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const uiDomain = await insertDomain({ domain: 'ui.example.net', send_account_id: ui.id })
    await route(null, 'newsletter', uiDomain.id)

    for (const env of [{ ...ENV, MAIL_FAKE_API_KEY: 'key-2' }, { ...ENV, MAIL_DOMAIN: 'x.example.org' }]) {
      const { mail: worker, fake } = harness({ env })
      expect(await worker.envAccountStatus()).toBe('mismatch')
      const res = await worker.send(mailFor('a@x.test'))
      expect(res).toMatchObject({ status: 'failed', retryable: true })
      expect(fake.sent).toHaveLength(0)
      expect((await worker.send(mailFor('a@x.test', { stream: 'newsletter' }))).status).toBe('sent')
    }

    const { mail: same } = harness()
    expect((await same.send(mailFor('a@x.test'))).status).toBe('sent')

    const fingerprint = (await db().selectFrom('mail_accounts').select('env_fingerprint').where('source', '=', 'env').executeTakeFirstOrThrow()).env_fingerprint!
    expect(fingerprint).not.toContain('key-1')
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('pauses on a different provider, and resumes in the same instance once the fingerprint matches', async () => {
    const { mail: app } = harness()
    await app.syncEnvAccount()
    const other = createFakeProvider('other')
    other.control.deliver = false
    const fake = createFakeProvider()
    fake.control.deliver = false
    const env: Record<string, string | undefined> = { ...ENV, MAIL_PROVIDER: 'other' }
    const worker = createMail({ db: db(), providers: [fake, other], streams: STREAMS, env, secretKey: SECRET, transport: 'provider', log: () => {} })
    expect(await worker.envAccountStatus()).toBe('mismatch')
    expect(await worker.send(mailFor('a@x.test'))).toMatchObject({ status: 'failed', retryable: true })

    // The app is redeployed with the worker's values; the worker resumes on its next recheck.
    const { mail: redeployed } = harness({ env, providers: [fake, other] })
    await redeployed.syncEnvAccount()
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 })
    try {
      expect(await worker.send(mailFor('a@x.test'))).toMatchObject({ status: 'sent' })
    } finally {
      vi.useRealTimers()
    }
    expect(other.sent.map(m => m.to)).toEqual(['a@x.test'])
  })

  it('pauses when no fingerprint is recorded yet', async () => {
    const { mail: app } = harness()
    await app.syncEnvAccount()
    await db().updateTable('mail_accounts').set({ env_fingerprint: null }).execute()
    const { mail: worker } = harness()
    expect(await worker.envAccountStatus()).toBe('missing')
    expect(await worker.send(mailFor('a@x.test'))).toMatchObject({ status: 'failed', retryable: true })
  })
})

describe('transports', () => {
  it('log and smtp call no provider for UI and env accounts alike', async () => {
    const ui = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const uiDomain = await insertDomain({ domain: 'ui.example.net', send_account_id: ui.id })
    await route(null, 'newsletter', uiDomain.id)
    for (const transport of ['log', { smtp: { host: '127.0.0.1', port: 1025 } }] as const) {
      const { mail, fake } = harness({ transport })
      await mail.syncEnvAccount()
      expect((await mail.send(mailFor('a@x.test'))).status).toBe('sent')
      expect((await mail.send(mailFor('a@x.test', { stream: 'newsletter' }))).status).toBe('sent')
      expect(fake.sent).toHaveLength(0)
    }
  })

  it('an SMTP server that accepts and never answers times out within the request timeout as unknown', async () => {
    const sockets = new Set<Socket>()
    const hung = createNetServer((s) => {
      sockets.add(s)
    })
    await new Promise<void>(r => hung.listen(0, '127.0.0.1', r))
    const { port } = hung.address() as AddressInfo
    try {
      const { mail } = harness({ transport: { smtp: { host: '127.0.0.1', port } }, requestTimeoutMs: 500 })
      await mail.syncEnvAccount()
      const started = Date.now()
      const res = await mail.send(mailFor('hang@x.test'))
      expect(res.status).toBe('unknown')
      expect(Date.now() - started).toBeLessThan(1500)
      expect(sockets.size).toBe(1)
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise(r => hung.close(r))
    }
  })

  it('issues no advisory lock or LISTEN on db', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    await mail.send(mailFor('a@x.test'))
    await mail.send(mailFor('b@x.test', { stream: 'queued' }))
    await mail.runOutboxSweep()
    expect(queries.some(q => /pg_advisory|pg_try_advisory|\blisten\b/i.test(q))).toBe(false)
  })
})

describe('resolution', () => {
  it('prefers org stream > org * > host stream > host * > env', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const org = await orgId()
    const orgStream = await insertDomain({ org_id: org, domain: 'a.org.test', send_account_id: acct.id })
    const orgStar = await insertDomain({ org_id: org, domain: 'b.org.test', send_account_id: acct.id })
    const hostStream = await insertDomain({ domain: 'c.host.test', send_account_id: acct.id })
    const hostStar = await insertDomain({ domain: 'd.host.test', send_account_id: acct.id })

    expect((await mail.resolveSender('newsletter', org))!.domain).toBe('mg.example.org')
    await route(null, '*', hostStar.id)
    expect((await mail.resolveSender('newsletter', org))!.domain).toBe('d.host.test')
    await route(null, 'newsletter', hostStream.id)
    expect((await mail.resolveSender('newsletter', org))!.domain).toBe('c.host.test')
    await route(org, '*', orgStar.id)
    expect((await mail.resolveSender('newsletter', org))!.domain).toBe('b.org.test')
    await route(org, 'newsletter', orgStream.id)
    expect((await mail.resolveSender('newsletter', org))!.domain).toBe('a.org.test')

    // Not orgAssignable: org rows never apply.
    await route(org, 'system', orgStream.id)
    expect((await mail.resolveSender('system', org))!.domain).toBe('d.host.test')
  })

  it('skips candidates whose ownership, sending or (for needsReceive) receiving is unverified', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const org = await orgId()
    const pending = await insertDomain({ org_id: org, domain: 'p.org.test', ownership_status: 'pending', send_account_id: acct.id })
    await route(org, '*', pending.id)
    expect((await mail.resolveSender('newsletter', org))!.domain).toBe('mg.example.org')

    const unsent = await insertDomain({ domain: 'u.host.test', send_status: 'pending', send_account_id: acct.id })
    await route(null, 'newsletter', unsent.id)
    expect((await mail.resolveSender('newsletter', org))!.domain).toBe('mg.example.org')

    const sendOnly = await insertDomain({ domain: 's.host.test', send_account_id: acct.id })
    await route(null, 'inbox', sendOnly.id)
    expect(await mail.resolveSender('inbox', null)).toBeNull()
    await db().updateTable('mail_domains').set({ receive_account_id: acct.id, receive_status: 'verified' }).where('id', '=', sendOnly.id).execute()
    expect((await mail.resolveSender('inbox', null))!.domain).toBe('s.host.test')
  })

  it('returns no_sender when nothing qualifies, sending nothing', async () => {
    const { mail, fake } = harness({ env: {} })
    expect(await mail.send(mailFor('a@x.test'))).toEqual({ status: 'no_sender', stream: 'system' })
    expect(fake.sent).toHaveLength(0)
  })

  it('a host with no env account and one default domain sends every stream through it, including streams added later', async () => {
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const domain = await insertDomain({ domain: 'only.example.net', send_account_id: acct.id })
    await route(null, '*', domain.id)
    const later = { id: 'later', label: 'Later', defaultLocal: 'hi', orgAssignable: false }
    const { mail, fake } = harness({ env: {}, streams: [...STREAMS, later] })
    for (const stream of ['system', 'account', 'newsletter', 'later']) {
      expect((await mail.send(mailFor('a@x.test', { stream }))).status).toBe('sent')
    }
    expect(fake.sent.every(m => m.domain === 'only.example.net')).toBe(true)
  })

  it('merges domain credentials over the account\'s; no usable key is key_rejected', async () => {
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { signingKey: 's' }) })
    const domain = await insertDomain({ domain: 'k.example.net', send_account_id: acct.id })
    await route(null, '*', domain.id)
    const { mail, fake } = harness({ env: {} })
    expect(await mail.send(mailFor('a@x.test'))).toMatchObject({ status: 'failed', retryable: false })
    expect((await db().selectFrom('mail_domains').select('send_error').where('id', '=', domain.id).executeTakeFirstOrThrow()).send_error).toBe('key_rejected')

    await db().updateTable('mail_domains').set({ send_status: 'verified', send_error: null, credentials: encryptJson(SECRET, { sendingKey: 'dk' }) }).where('id', '=', domain.id).execute()
    expect((await mail.send(mailFor('a@x.test'))).status).toBe('sent')
    expect(fake.sent).toHaveLength(1)
  })

  it('a domain key overrides the account key of the same name; a rejected key marks the domain', async () => {
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'account-key', signingKey: 's' }) })
    const domain = await insertDomain({ domain: 'both.example.net', send_account_id: acct.id, credentials: encryptJson(SECRET, { apiKey: 'domain-key' }) })
    await route(null, '*', domain.id)
    const fake = createFakeProvider()
    const keys: string[] = []
    const send = fake.send
    fake.send = async (creds, msg) => {
      keys.push(`${creds.apiKey}/${creds.signingKey}`)
      return await send(creds, msg)
    }
    const { mail } = harness({ env: {}, fake })
    expect((await mail.send(mailFor('a@x.test'))).status).toBe('sent')
    expect(keys).toEqual(['domain-key/s'])

    await db().updateTable('mail_domains').set({ credentials: encryptJson(SECRET, { apiKey: 'reject' }) }).where('id', '=', domain.id).execute()
    expect(await mail.send(mailFor('a@x.test'))).toMatchObject({ status: 'failed', retryable: false })
    expect(await db().selectFrom('mail_domains').select(['send_status', 'send_error']).where('id', '=', domain.id).executeTakeFirstOrThrow())
      .toEqual({ send_status: 'failed', send_error: 'key_rejected' })
  })
})

describe('suppressions and guards', () => {
  async function suppress(address: string, scope: 'global' | 'host' | 'org', reason: 'hard_bounce' | 'complaint', org: string | null = null) {
    await db().insertInto('mail_suppressions').values({
      address_hash: addressHash(address), scope, reason, org_id: org, occurred_at: new Date()
    }).execute()
  }

  it('a global hard bounce suppresses normal streams but not userInitiated ones', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    await suppress('dead@x.test', 'global', 'hard_bounce')
    expect(await mail.send(mailFor('Dead@X.test'))).toEqual({ status: 'suppressed', reason: 'hard_bounce' })
    expect((await mail.send(mailFor('dead@x.test', { stream: 'account' }))).status).toBe('sent')
  })

  it('a hard bounce and a complaint are two rows; complaint is reported; clearing the bounce leaves it', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    await suppress('p@x.test', 'host', 'complaint')
    await suppress('p@x.test', 'global', 'hard_bounce')
    expect(await mail.send(mailFor('p@x.test'))).toEqual({ status: 'suppressed', reason: 'complaint' })
    await db().updateTable('mail_suppressions').set({ cleared_at: new Date() }).where('reason', '=', 'hard_bounce').execute()
    expect(await mail.isSuppressed('p@x.test')).toEqual({ reason: 'complaint', scope: 'host' })
  })

  it('org and host scopes apply only to their own sends', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    const a = await orgId()
    const b = await orgId()
    await suppress('o@x.test', 'org', 'complaint', a)
    await suppress('h@x.test', 'host', 'complaint')
    expect(await mail.isSuppressed('o@x.test', { orgId: a })).toBeTruthy()
    expect(await mail.isSuppressed('o@x.test', { orgId: b })).toBe(false)
    expect(await mail.isSuppressed('o@x.test')).toBe(false)
    expect(await mail.isSuppressed('h@x.test')).toBeTruthy()
    expect(await mail.isSuppressed('h@x.test', { orgId: a })).toBe(false)
    expect(await mail.suppressedAmong(['o@x.test', 'h@x.test', 'n@x.test'], { orgId: a })).toEqual(new Set(['o@x.test']))
  })

  it('mail_is_suppressed() and notSuppressed() agree with isSuppressed', async () => {
    const { mail } = harness()
    const a = await orgId()
    await suppress('g@x.test', 'global', 'hard_bounce')
    await suppress('o@x.test', 'org', 'complaint', a)
    await suppress('h@x.test', 'host', 'complaint')
    for (const address of ['g@x.test', 'o@x.test', 'h@x.test', 'n@x.test']) {
      for (const org of [null, a]) {
        const expected = !!(await mail.isSuppressed(address, { orgId: org }))
        const fn = await sql<{ s: boolean }>`select mail_is_suppressed(${address}, ${org}::uuid) as s`.execute(db())
        expect(fn.rows[0]!.s, `${address} ${org}`).toBe(expected)
        const typed = await db()
          .selectNoFrom(eb => eb.val(1).as('one'))
          .where(eb => notSuppressed(eb, sql.val(address), org ? sql.val(org) : null))
          .execute()
        expect(typed.length === 0, `${address} ${org} typed`).toBe(expected)
      }
    }
  })

  it('addressHash equals the SQL expression', async () => {
    for (const address of ['Mixed@Example.ORG', '  padded@example.org  ', 'ÜNÏcode@exämple.org']) {
      const res = await sql<{ h: string }>`select encode(sha256(convert_to(lower(btrim(${address})), 'UTF8')), 'hex') as h`.execute(db())
      expect(addressHash(address), address).toBe(res.rows[0]!.h)
    }
  })

  it('asks the provider to bypass its list only on a mirrored domain', async () => {
    await suppress('hb@x.test', 'global', 'hard_bounce')
    for (const mode of ['mirrored', 'unmanaged', 'disabled'] as const) {
      const fake = createFakeProvider()
      fake.control.mode = mode
      const { mail } = harness({ fake })
      await mail.syncEnvAccount()
      expect((await mail.send(mailFor('hb@x.test', { stream: 'account' }))).status).toBe('sent')
      expect((await mail.send(mailFor('fine@x.test', { stream: 'account' }))).status).toBe('sent')
      expect(fake.sent.map(m => m.bypassProviderSuppression), mode).toEqual([mode === 'mirrored', false])
    }
  })

  it('a guard can refuse, and sees the account owner', async () => {
    const org = await orgId()
    const acct = await insertAccount({ org_id: org, credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const domain = await insertDomain({ org_id: org, domain: 'g.org.test', send_account_id: acct.id })
    await route(org, '*', domain.id)
    const seen: (string | null)[] = []
    const { mail, fake } = harness({
      env: {},
      guards: [{ id: 'no-org-accounts', check: async (_m, ctx) => {
        seen.push(ctx.accountOrgId)
        return ctx.accountOrgId ? { ok: false, reason: 'org accounts are off' } : { ok: true }
      } }]
    })
    expect(await mail.send(mailFor('a@x.test', { stream: 'newsletter', orgId: org })))
      .toEqual({ status: 'refused', guard: 'no-org-accounts', reason: 'org accounts are off' })
    expect(seen).toEqual([org])
    expect(fake.sent).toHaveLength(0)
  })
})

describe('timing options', () => {
  it('a sweep tick of 0 or not a number becomes the minimum or the default, never off', () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    try {
      for (const [sweepSeconds, ms] of [[0, 5000], [Number.NaN, 30_000], [2, 5000], [45, 45_000]] as const) {
        spy.mockClear()
        const { mail } = harness({ sweepSeconds })
        mail.startSweeping()
        expect(spy.mock.calls.map(c => c[1]), String(sweepSeconds)).toEqual([ms])
        void mail.stop()
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('a lease is never shorter than the request timeout plus a margin', async () => {
    const fake = createFakeProvider()
    fake.control.hangMs = 300
    const { mail } = harness({ fake, leaseSeconds: 1, requestTimeoutMs: 20_000 })
    await mail.syncEnvAccount()
    const { outboxId } = await db().transaction().execute(tx => mail.enqueue(mailFor('l@x.test'), { tx }))
    const run = mail.flush([outboxId])
    await new Promise(r => setTimeout(r, 100))
    const row = await db().selectFrom('mail_outbox').select(sql<number>`extract(epoch from claimed_until - now())`.as('left')).where('id', '=', outboxId).executeTakeFirstOrThrow()
    expect(Number(row.left)).toBeGreaterThan(20)
    await run
  })
})

describe('validation and keys', () => {
  it('rejects a ref with other characters or over 64 long', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    await expect(mail.send(mailFor('a@x.test', { ref: 'has space' }))).rejects.toThrow(/ref/)
    await expect(mail.send(mailFor('a@x.test', { ref: 'x'.repeat(65) }))).rejects.toThrow(/ref/)
    await expect(db().transaction().execute(tx => mail.enqueue(mailFor('a@x.test', { ref: 'a.b' }), { tx }))).rejects.toThrow(/ref/)
    expect((await mail.send(mailFor('a@x.test', { ref: 'msg_1-ok' }))).status).toBe('sent')
  })

  it('reads values encrypted by core\'s secret-crypto, and core reads the kernel\'s', async () => {
    (globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ secretEncryptionKey: SECRET })
    const core = await import('../../core/server/utils/secret-crypto')
    const fromCore = core.encryptJson({ apiKey: 'abc' })
    expect(decryptJson(SECRET, fromCore)).toEqual({ apiKey: 'abc' })
    expect(core.decryptJson(encryptJson(SECRET, { apiKey: 'xyz' }))).toEqual({ apiKey: 'xyz' })
  })

  it('an instance without secretKey resolves and checks suppressions, and throws on send', async () => {
    const { mail: app } = harness()
    await app.syncEnvAccount()
    const enqueueOnly = createMail({ db: db(), providers: [createFakeProvider()], streams: STREAMS, env: ENV, outboxPublicKey: app.outboxPublicKey, log: () => {} })
    expect((await enqueueOnly.resolveSender('system'))!.domain).toBe('mg.example.org')
    expect(await enqueueOnly.isSuppressed('a@x.test')).toBe(false)
    await expect(enqueueOnly.send(mailFor('a@x.test'))).rejects.toThrow(/secret key/)
    expect(() => createMail({ db: db(), providers: [], streams: STREAMS, env: {} })).toThrow(/outboxPublicKey/)
    expect(harness({ secretKey: OTHER_SECRET }).mail.outboxPublicKey).not.toBe(app.outboxPublicKey)
  })
})
