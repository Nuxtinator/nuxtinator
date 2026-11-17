import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import postgres from 'postgres'
import { addressHash, createMail, encryptJson } from '../kernel'
import { createFakeProvider } from '../test'
import { db, ENV, harness, insertAccount, insertDomain, mailFor, OTHER_SECRET, resetTables, route, SECRET, STREAMS, TEST_SCHEMA } from './helpers'

beforeEach(resetTables)
afterAll(async () => {
  await db().destroy()
})

const outbox = () => db().selectFrom('mail_outbox').selectAll().orderBy('created_at').execute()

async function makeDue() {
  await db().updateTable('mail_outbox').set({ next_attempt_at: sql`now() - interval '1 second'` }).where('status', '=', 'queued').execute()
}

describe('outbox', () => {
  it('send on a queued stream makes its first attempt with no sweep tick', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    const res = await mail.send(mailFor('a@x.test', { stream: 'queued' }))
    expect(res.status).toBe('sent')
    expect(fake.sent).toHaveLength(1)
    const [row] = await outbox()
    expect(row).toMatchObject({ status: 'sent', message: null, attempts: 1 })
  })

  it('send on a queued stream reports suppressed, and queued after a retryable failure', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    await db().insertInto('mail_suppressions').values({ address_hash: addressHash('s@x.test'), scope: 'global', reason: 'hard_bounce', occurred_at: new Date() }).execute()
    expect(await mail.send(mailFor('s@x.test', { stream: 'queued' }))).toEqual({ status: 'suppressed', reason: 'hard_bounce' })
    fake.control.nextResults.push({ status: 'failed', retryable: true, error: '503' })
    const res = await mail.send(mailFor('r@x.test', { stream: 'queued' }))
    expect(res.status).toBe('queued')
  })

  it('enqueue in a rolled-back transaction leaves nothing; after commit a subscribed sweeper sends without the tick', async () => {
    const listener = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: `${TEST_SCHEMA},public` } })
    const { mail, fake } = harness({
      subscribe: (channel, onNotify) => {
        void listener.listen(channel, () => onNotify())
      }
    })
    await mail.syncEnvAccount()
    mail.startSweeping()
    await new Promise(r => setTimeout(r, 200))

    await db().transaction().execute(async (tx) => {
      await mail.enqueue(mailFor('rollback@x.test'), { tx })
      throw new Error('rollback')
    }).catch(() => {})
    expect(await outbox()).toHaveLength(0)

    await db().transaction().execute(tx => mail.enqueue(mailFor('commit@x.test'), { tx }))
    const deadline = Date.now() + 5000
    while (fake.sent.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    expect(fake.sent.map(m => m.to)).toEqual(['commit@x.test'])
    await mail.stop()
    await listener.end()
  })

  it('flush sends at once; an enqueue-only instance can enqueue with just the public key and refuses to flush', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    const enqueuer = createMail({ db: db(), providers: [createFakeProvider()], streams: STREAMS, env: ENV, outboxPublicKey: mail.outboxPublicKey, log: () => {} })
    const { outboxId } = await db().transaction().execute(tx => enqueuer.enqueue(mailFor('f@x.test'), { tx }))
    await expect(enqueuer.flush([outboxId])).rejects.toThrow(/secret key/)
    const [row] = await outbox()
    expect(row!.message).toMatch(/^x1\./)
    expect(row!.message).not.toContain('f@x.test')
    await mail.flush([outboxId])
    expect(fake.sent.map(m => m.to)).toEqual(['f@x.test'])
  })

  it('a body queued under a different key fails with a clear error', async () => {
    const { mail: other } = harness({ secretKey: OTHER_SECRET })
    await db().transaction().execute(tx => other.enqueue(mailFor('k@x.test'), { tx }))
    const { mail } = harness()
    await mail.syncEnvAccount()
    await mail.runOutboxSweep()
    const [row] = await outbox()
    expect(row).toMatchObject({ status: 'failed', message: null })
    expect(row!.last_error).toMatch(/different key/)
  })

  it('a suppression or guard added between enqueue and send applies', async () => {
    let refuse = false
    const { mail, fake } = harness({ guards: [{ id: 'g', check: async () => refuse ? { ok: false, reason: 'no' } : { ok: true } }] })
    await mail.syncEnvAccount()
    const a = await db().transaction().execute(tx => mail.enqueue(mailFor('late@x.test'), { tx }))
    await db().insertInto('mail_suppressions').values({ address_hash: addressHash('late@x.test'), scope: 'host', reason: 'complaint', occurred_at: new Date() }).execute()
    await mail.flush([a.outboxId])
    const b = await db().transaction().execute(tx => mail.enqueue(mailFor('guarded@x.test'), { tx }))
    refuse = true
    await mail.flush([b.outboxId])
    const rows = await outbox()
    expect(rows.map(r => [r.status, r.last_error])).toEqual([['failed', 'suppressed'], ['failed', 'refused by g: no']])
    expect(fake.sent).toHaveLength(0)
  })

  it('retries with backoff, and fails a permanent error at once', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    fake.control.nextResults.push({ status: 'failed', retryable: true, error: '503' }, { status: 'failed', retryable: true, error: '503' })
    const { outboxId } = await db().transaction().execute(tx => mail.enqueue(mailFor('b@x.test'), { tx }))
    await mail.flush([outboxId])
    let [row] = await outbox()
    expect(row).toMatchObject({ status: 'queued', attempts: 1 })
    const delay = (+new Date(row!.next_attempt_at!) - Date.now()) / 60_000
    expect(delay).toBeGreaterThan(0.9)
    await mail.runOutboxSweep()
    expect((await outbox())[0]!.attempts).toBe(1)
    await makeDue()
    await mail.runOutboxSweep()
    ;[row] = await outbox()
    expect(row).toMatchObject({ status: 'queued', attempts: 2 })
    expect((+new Date(row!.next_attempt_at!) - Date.now()) / 60_000).toBeGreaterThan(4.9)
    await makeDue()
    await mail.runOutboxSweep()
    expect((await outbox())[0]).toMatchObject({ status: 'sent', attempts: 3 })

    fake.control.nextResults.push({ status: 'failed', retryable: false, error: 'bad address' })
    const p = await db().transaction().execute(tx => mail.enqueue(mailFor('p@x.test'), { tx }))
    await mail.flush([p.outboxId])
    expect((await outbox()).find(r => r.id === p.outboxId)).toMatchObject({ status: 'failed', last_error: 'bad address', message: null })
  })

  it('two sweepers and a flush of the same row call the provider once', async () => {
    const fake = createFakeProvider()
    const { mail: a } = harness({ fake })
    const { mail: b } = harness({ fake })
    await a.syncEnvAccount()
    const ids: string[] = []
    for (let i = 0; i < 15; i++) {
      ids.push((await db().transaction().execute(tx => a.enqueue(mailFor(`c${i}@x.test`), { tx }))).outboxId)
    }
    await Promise.all([a.runOutboxSweep(), b.runOutboxSweep(), a.flush(ids.slice(0, 5)), b.flush(ids.slice(0, 5))])
    expect(fake.sent).toHaveLength(15)
    expect(new Set(fake.sent.map(m => m.to)).size).toBe(15)
  })

  it('a process stopped after claiming but before any call: rows return to queued with no attempt counted', async () => {
    const { mail } = harness({ leaseSeconds: 1 })
    await mail.syncEnvAccount()
    for (let i = 0; i < 3; i++) await db().transaction().execute(tx => mail.enqueue(mailFor(`s${i}@x.test`), { tx }))
    await db().updateTable('mail_outbox').set({ status: 'sending', claimed_by: 'dead-process', claimed_until: sql`now() - interval '1 second'` }).execute()
    const { mail: next, fake } = harness()
    await next.runOutboxSweep()
    const rows = await outbox()
    expect(rows.every(r => r.status === 'sent' && r.attempts === 1)).toBe(true)
    expect(fake.sent).toHaveLength(3)
  })

  it('a process stopped mid-call: that row is finalized as sent (outcome unknown), the others requeued', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    for (let i = 0; i < 3; i++) await db().transaction().execute(tx => mail.enqueue(mailFor(`m${i}@x.test`), { tx }))
    const rows = await outbox()
    await db().updateTable('mail_outbox').set({ status: 'sending', claimed_by: 'dead', claimed_until: sql`now() - interval '1 second'` }).execute()
    await db().updateTable('mail_outbox').set({ attempt_started_at: sql`now() - interval '3 minutes'`, attempts: 1 }).where('id', '=', rows[0]!.id).execute()
    const { mail: next, fake } = harness()
    await next.runOutboxSweep()
    const after = await outbox()
    expect(after.find(r => r.id === rows[0]!.id)).toMatchObject({ status: 'sent', last_error: 'outcome unknown', message: null })
    expect(fake.sent.map(m => m.to).sort()).toEqual(['m1@x.test', 'm2@x.test'])
  })

  it('a slow batch outliving its lease: every row is sent once, and the first process skips rows it lost', async () => {
    const fake = createFakeProvider()
    const { mail: slow } = harness({ fake, leaseSeconds: 1, requestTimeoutMs: 700 })
    const { mail: other } = harness({ fake, leaseSeconds: 30 })
    await slow.syncEnvAccount()
    fake.control.hangFor.add('h0@x.test')
    fake.control.hangFor.add('h1@x.test')
    for (const to of ['h0@x.test', 'h1@x.test', 'ok2@x.test', 'ok3@x.test']) {
      await db().transaction().execute(tx => slow.enqueue(mailFor(to), { tx }))
      await new Promise(r => setTimeout(r, 5))
    }
    const first = slow.runOutboxSweep()
    await new Promise(r => setTimeout(r, 1200))
    await other.runOutboxSweep()
    await first
    const rows = await outbox()
    const sent = fake.sent.map(m => m.to)
    expect(sent.filter(t => t === 'ok2@x.test')).toHaveLength(1)
    expect(sent.filter(t => t === 'ok3@x.test')).toHaveLength(1)
    expect(rows.find(r => r.last_error === 'outcome unknown')).toBeTruthy()
    expect(rows.every(r => r.status === 'sent')).toBe(true)
  })

  it('an outcome recorded by a process that lost its claim changes nothing', async () => {
    const fake = createFakeProvider()
    const { mail } = harness({ fake, requestTimeoutMs: 60_000 })
    await mail.syncEnvAccount()
    fake.control.hangMs = 400
    const { outboxId } = await db().transaction().execute(tx => mail.enqueue(mailFor('lost@x.test'), { tx }))
    const run = mail.flush([outboxId])
    await new Promise(r => setTimeout(r, 150))
    await db().updateTable('mail_outbox').set({ claimed_by: 'someone-else', status: 'failed', last_error: 'taken' }).where('id', '=', outboxId).execute()
    await run
    expect((await outbox())[0]).toMatchObject({ status: 'failed', last_error: 'taken' })
  })

  it('stop() requeues unstarted claims immediately', async () => {
    const fake = createFakeProvider()
    fake.control.hangFor.add('st1@x.test')
    const { mail } = harness({ fake, requestTimeoutMs: 60_000 })
    await mail.syncEnvAccount()
    const first = await db().transaction().execute(tx => mail.enqueue(mailFor('st1@x.test'), { tx }))
    await new Promise(r => setTimeout(r, 5))
    const second = await db().transaction().execute(tx => mail.enqueue(mailFor('st2@x.test'), { tx }))
    void mail.flush([first.outboxId, second.outboxId])
    await new Promise(r => setTimeout(r, 150))
    expect((await outbox()).map(r => r.status)).toEqual(['sending', 'sending'])
    await mail.stop()
    const rows = await outbox()
    expect(rows.find(r => r.id === first.outboxId)!.attempt_started_at).not.toBeNull()
    expect(rows.find(r => r.id === second.outboxId)).toMatchObject({ status: 'queued', claimed_by: null, attempts: 0 })
  })

  it('an adapter call that hangs is aborted before the lease expires', async () => {
    const fake = createFakeProvider()
    fake.control.hangFor.add('hang@x.test')
    const { mail } = harness({ fake, requestTimeoutMs: 300, leaseSeconds: 5 })
    await mail.syncEnvAccount()
    const started = Date.now()
    const res = await mail.send(mailFor('hang@x.test', { stream: 'queued' }))
    expect(Date.now() - started).toBeLessThan(3000)
    expect(res.status).toBe('queued')
    expect((await outbox())[0]).toMatchObject({ status: 'sent', last_error: 'outcome unknown' })
  })

  it('no sender and the env-account pause release rows with no attempt counted, five minutes ahead', async () => {
    const { mail: app } = harness()
    await app.syncEnvAccount()
    const { mail: worker } = harness({ env: { ...ENV, MAIL_FAKE_API_KEY: 'other' } })
    const paused = await db().transaction().execute(tx => worker.enqueue(mailFor('p@x.test'), { tx }))
    const nosender = await db().transaction().execute(tx => worker.enqueue(mailFor('n@x.test', { stream: 'inbox' }), { tx }))
    await worker.runOutboxSweep()
    for (const id of [paused.outboxId, nosender.outboxId]) {
      const row = (await outbox()).find(r => r.id === id)!
      expect(row).toMatchObject({ status: 'queued', attempts: 0 })
      expect((+new Date(row.next_attempt_at!) - Date.now()) / 60_000).toBeGreaterThan(4.9)
    }
    await makeDue()
    await app.runOutboxSweep()
    expect((await outbox()).find(r => r.id === paused.outboxId)!.status).toBe('sent')
  })

  it('a row on a stream this instance doesn\'t know is left for one that does', async () => {
    const { mail: newer } = harness({ streams: [...STREAMS, { id: 'brand-new', label: 'New', defaultLocal: 'n', orgAssignable: false }] })
    await newer.syncEnvAccount()
    const { outboxId } = await db().transaction().execute(tx => newer.enqueue(mailFor('u@x.test', { stream: 'brand-new' }), { tx }))
    const { mail: older, fake: olderFake } = harness()
    await older.runOutboxSweep()
    expect(olderFake.sent).toHaveLength(0)
    expect((await outbox())[0]!.status).toBe('queued')
    await newer.runOutboxSweep()
    expect((await outbox()).find(r => r.id === outboxId)!.status).toBe('sent')
  })

  it('twenty unsendable rows at the head don\'t hold up a sendable row', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    for (let i = 0; i < 20; i++) await db().transaction().execute(tx => mail.enqueue(mailFor(`n${i}@x.test`, { stream: 'inbox' }), { tx }))
    await db().transaction().execute(tx => mail.enqueue(mailFor('go@x.test'), { tx }))
    await mail.runOutboxSweep()
    expect(fake.sent.map(m => m.to)).toEqual(['go@x.test'])
  })

  it('expiry: a short-lived message fails as expired with its body deleted; others survive', async () => {
    const { mail, fake } = harness()
    await mail.syncEnvAccount()
    const short = await db().transaction().execute(tx => mail.enqueue(mailFor('r@x.test', { stream: 'reset', expiresInMinutes: 50 }), { tx }))
    const long = await db().transaction().execute(tx => mail.enqueue(mailFor('v@x.test', { stream: 'reset' }), { tx }))
    const def = await db().transaction().execute(tx => mail.enqueue(mailFor('d@x.test'), { tx }))
    await db().updateTable('mail_outbox').set({ created_at: sql`now() - interval '2 hours'`, expires_at: sql`expires_at - interval '2 hours'` }).execute()
    await mail.runOutboxSweep()
    const rows = await outbox()
    expect(rows.find(r => r.id === short.outboxId)).toMatchObject({ status: 'failed', last_error: 'expired', message: null })
    expect(rows.find(r => r.id === long.outboxId)!.status).toBe('sent')
    expect(rows.find(r => r.id === def.outboxId)!.status).toBe('sent')
    expect(fake.sent.map(m => m.to).sort()).toEqual(['d@x.test', 'v@x.test'])

    const old = await db().transaction().execute(tx => mail.enqueue(mailFor('o@x.test', { stream: 'inbox' }), { tx }))
    await db().updateTable('mail_outbox').set({ expires_at: sql`now() - interval '1 minute'` }).where('id', '=', old.outboxId).execute()
    await mail.runOutboxSweep()
    expect((await outbox()).find(r => r.id === old.outboxId)).toMatchObject({ status: 'failed', last_error: 'expired', message: null })
  })

  it('the purge removes only terminal rows older than 7 days', async () => {
    const { mail } = harness()
    await mail.syncEnvAccount()
    await mail.send(mailFor('a@x.test', { stream: 'queued' }))
    await db().transaction().execute(tx => mail.enqueue(mailFor('q@x.test', { stream: 'inbox' }), { tx }))
    await db().updateTable('mail_outbox').set({ created_at: sql`now() - interval '8 days'`, sent_at: sql`now() - interval '8 days'` }).execute()
    expect(await mail.purgeOutbox()).toBe(1)
    expect((await outbox()).map(r => r.status)).toEqual(['queued'])
  })
})

describe('outbox with UI accounts', () => {
  it('sends through a UI account with stored credentials', async () => {
    const acct = await insertAccount({ credentials: encryptJson(SECRET, { apiKey: 'k' }) })
    const domain = await insertDomain({ domain: 'ui.example.net', send_account_id: acct.id })
    await route(null, '*', domain.id)
    const { mail, fake } = harness({ env: {} })
    expect((await mail.send(mailFor('a@x.test', { stream: 'queued' }))).status).toBe('sent')
    expect(fake.sent[0]!.domain).toBe('ui.example.net')
  })
})
