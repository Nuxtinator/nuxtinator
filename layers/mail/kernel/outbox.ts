// The outbox. A row is claimed with a lease (`claimed_by` + `claimed_until`);
// immediately before its provider call one conditional statement marks the
// attempt started and renews the lease, and every later write is conditional
// on still holding the claim. So a row is only ever sent by the claim that
// holds it, with no advisory lock or session state on the pooled `db`.
//
// When a lease runs out, `attempt_started_at` says what happened: unset, the
// row goes back to `queued` with no attempt counted; set, the outcome is
// unknown and the row is finalized as sent (at most once).
import { sql, type Transaction } from 'kysely'
import { requireSecret, type Kernel } from './context'
import { randomToken, seal, unseal } from './crypto'
import { deliver, prepareSend, validateMail } from './send'
import type { MailDatabase, MailOutboxRow } from './schema'
import type { OutgoingMail, SendResult } from './types'

const BACKOFF_MINUTES = [1, 5, 15, 60, 240]
const MAX_ATTEMPTS = 6
const BATCH = 10
const HOLD_MINUTES = 5
const DEFAULT_MAX_AGE_MINUTES = 1440

export const OUTBOX_CHANNEL = 'nx_mail_outbox'

interface StoredMail extends Omit<OutgoingMail, 'attachments'> {
  attachments?: { filename: string, contentType: string, data: string, cid?: string }[]
}

function serialize(m: OutgoingMail): string {
  const stored: StoredMail = {
    ...m,
    attachments: m.attachments?.map(a => ({ ...a, data: a.data.toString('base64') }))
  }
  return JSON.stringify(stored)
}

function deserialize(json: string): OutgoingMail {
  const stored = JSON.parse(json) as StoredMail
  return {
    ...stored,
    attachments: stored.attachments?.map(a => ({ ...a, data: Buffer.from(a.data, 'base64') }))
  }
}

function expiryMinutes(k: Kernel, m: OutgoingMail): number {
  return m.expiresInMinutes ?? k.streams.get(m.stream)?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES
}

function lease(k: Kernel) {
  return sql<Date>`now() + make_interval(secs => ${k.leaseSeconds})`
}

export async function enqueue(k: Kernel, m: OutgoingMail, tx: Transaction<any>): Promise<{ status: 'queued', outboxId: string }> {
  validateMail(k, m)
  if (m.attachments?.length) throw new Error('enqueue takes no attachments')
  const t = tx as Transaction<MailDatabase>
  const row = await t
    .insertInto('mail_outbox')
    .values({
      org_id: m.orgId ?? null,
      stream: m.stream,
      message: seal(k.outboxPublicKey, serialize(m)),
      next_attempt_at: sql<Date>`now()`,
      expires_at: sql<Date>`now() + make_interval(mins => ${expiryMinutes(k, m)})`
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await sql`select pg_notify(${OUTBOX_CHANNEL}, ${row.id})`.execute(t)
  return { status: 'queued', outboxId: row.id }
}

// A fresh token for one claim. A row is only ever written by the claim that
// holds it, so two claims in one process can't both act on a row.
function newClaim(k: Kernel): string {
  const token = randomToken(12)
  k.claims.add(token)
  return token
}

// send() on a queued stream: the row is written already claimed by this
// process, so the first attempt can't race a sweeper. Like enqueue, it takes
// no attachments: the stored message never holds any.
export async function sendQueued(k: Kernel, m: OutgoingMail): Promise<SendResult> {
  validateMail(k, m)
  if (m.attachments?.length) throw new Error('A queued stream takes no attachments')
  requireSecret(k, 'send mail')
  const token = newClaim(k)
  try {
    return await sendQueuedAs(k, m, token)
  } finally {
    k.claims.delete(token)
  }
}

async function sendQueuedAs(k: Kernel, m: OutgoingMail, token: string): Promise<SendResult> {
  const row = await k.db
    .insertInto('mail_outbox')
    .values({
      org_id: m.orgId ?? null,
      stream: m.stream,
      message: seal(k.outboxPublicKey, serialize(m)),
      status: 'sending',
      claimed_by: token,
      claimed_until: lease(k),
      next_attempt_at: sql<Date>`now()`,
      expires_at: sql<Date>`now() + make_interval(mins => ${expiryMinutes(k, m)})`
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  const result = await attemptRow(k, row)
  if (result && (result.status === 'sent' || result.status === 'suppressed' || result.status === 'refused'
    || result.status === 'unknown' || (result.status === 'failed' && !result.retryable))) {
    return result
  }
  return { status: 'queued', outboxId: row.id }
}

async function claim(k: Kernel, token: string, ids?: string[]): Promise<MailOutboxRow[]> {
  const streams = [...k.streams.keys()]
  if (streams.length === 0) return []
  const res = await sql<MailOutboxRow>`
    UPDATE mail_outbox
       SET status = 'sending', claimed_by = ${token}, claimed_until = ${lease(k)}
     WHERE id IN (
       SELECT id FROM mail_outbox
        WHERE status = 'queued'
          AND next_attempt_at <= now()
          AND stream = ANY(${streams}::text[])
          ${ids ? sql`AND id = ANY(${ids}::uuid[])` : sql``}
        ORDER BY next_attempt_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `.execute(k.db)
  return res.rows.sort((a, b) => +new Date(a.next_attempt_at!) - +new Date(b.next_attempt_at!))
}

type Claimed = Pick<MailOutboxRow, 'id' | 'claimed_by'>

function held(k: Kernel, row: Claimed) {
  return k.db.updateTable('mail_outbox').where('id', '=', row.id).where('claimed_by', '=', row.claimed_by)
}

async function finalize(k: Kernel, row: Claimed, status: 'sent' | 'failed', fields: { last_error?: string | null, provider_message_id?: string | null } = {}) {
  await held(k, row)
    .set({
      status,
      message: null,
      claimed_by: null,
      claimed_until: null,
      attempt_started_at: null,
      ...(status === 'sent' ? { sent_at: sql<Date>`now()` } : {}),
      ...fields
    })
    .execute()
}

async function release(k: Kernel, row: Claimed, delayMinutes: number, lastError: string | null) {
  await held(k, row)
    .set({
      status: 'queued',
      claimed_by: null,
      claimed_until: null,
      attempt_started_at: null,
      next_attempt_at: sql<Date>`now() + make_interval(mins => ${delayMinutes})`,
      last_error: lastError
    })
    .execute()
}

// One claimed row, start to finish. Returns the attempt's result, or null
// when the row was skipped because this process no longer holds it.
async function attemptRow(k: Kernel, row: MailOutboxRow): Promise<SendResult | null> {
  if (new Date(row.expires_at) <= new Date()) {
    await finalize(k, row, 'failed', { last_error: 'expired' })
    return { status: 'failed', retryable: false, error: 'expired' }
  }

  let m: OutgoingMail
  try {
    m = deserialize(unseal(k.outboxKeys!, row.message ?? ''))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await finalize(k, row, 'failed', { last_error: error })
    return { status: 'failed', retryable: false, error }
  }

  // A throw here (a database blip during resolution or the suppression
  // check) happens before any provider call, so the row is simply tried later.
  let prepared
  try {
    prepared = await prepareSend(k, m)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await release(k, row, HOLD_MINUTES, error)
    return { status: 'failed', retryable: true, error }
  }

  if (prepared.kind === 'hold') {
    await release(k, row, HOLD_MINUTES, prepared.reason)
    return prepared.result
  }
  if (prepared.kind === 'final') {
    const r = prepared.result
    const error = r.status === 'suppressed'
      ? 'suppressed'
      : r.status === 'refused'
        ? `refused by ${r.guard}: ${r.reason}`
        : r.status === 'failed' ? r.error : r.status
    await finalize(k, row, 'failed', { last_error: error })
    return r
  }

  const started = await held(k, row)
    .where('claimed_until', '>', sql<Date>`now()`)
    .set({
      attempt_started_at: sql<Date>`now()`,
      attempts: sql<number>`attempts + 1`,
      claimed_until: lease(k)
    })
    .returning('attempts')
    .executeTakeFirst()
  if (!started) return null

  const result = await deliver(k, prepared)
  if (result.status === 'sent') {
    await finalize(k, row, 'sent', { provider_message_id: result.providerMessageId, last_error: null })
  } else if (result.status === 'unknown') {
    await finalize(k, row, 'sent', { last_error: 'outcome unknown' })
  } else if (result.status === 'failed' && result.retryable && started.attempts < MAX_ATTEMPTS) {
    await release(k, row, BACKOFF_MINUTES[started.attempts - 1] ?? BACKOFF_MINUTES.at(-1)!, result.error)
  } else if (result.status === 'failed') {
    await finalize(k, row, 'failed', { last_error: result.error })
  }
  return result
}

async function attemptBatch(k: Kernel, rows: MailOutboxRow[]): Promise<Map<string, SendResult | null>> {
  const out = new Map<string, SendResult | null>()
  for (const row of rows) {
    if (k.stopped) break
    try {
      out.set(row.id, await attemptRow(k, row))
    } catch (err) {
      k.log(`[mail] outbox row ${row.id} failed unexpectedly: ${err instanceof Error ? err.message : err}`)
      out.set(row.id, null)
    }
  }
  return out
}

// One claim and its batch, with the claim's token held until the batch is done.
async function claimAndAttempt(k: Kernel, ids?: string[]): Promise<MailOutboxRow[]> {
  const token = newClaim(k)
  try {
    const rows = await claim(k, token, ids)
    await attemptBatch(k, rows)
    return rows
  } finally {
    k.claims.delete(token)
  }
}

// Attempts every due row among `ids`, a batch at a time.
export async function flush(k: Kernel, ids: string[]): Promise<void> {
  requireSecret(k, 'flush the outbox')
  let remaining = [...new Set(ids)]
  while (remaining.length > 0 && !k.stopped) {
    const rows = await claimAndAttempt(k, remaining)
    if (rows.length === 0) break
    const done = new Set(rows.map(r => r.id))
    remaining = remaining.filter(id => !done.has(id))
  }
}

// Rows whose lease ran out: requeued when the call never started, finalized
// as sent when it did. Then expired rows fail.
async function recoverLeases(k: Kernel): Promise<void> {
  await sql`
    UPDATE mail_outbox
       SET status = 'queued', claimed_by = NULL, claimed_until = NULL
     WHERE status = 'sending' AND claimed_until < now() AND attempt_started_at IS NULL
  `.execute(k.db)
  await sql`
    UPDATE mail_outbox
       SET status = 'sent', sent_at = now(), message = NULL, claimed_by = NULL, claimed_until = NULL,
           attempt_started_at = NULL, last_error = 'outcome unknown'
     WHERE status = 'sending' AND claimed_until < now() AND attempt_started_at IS NOT NULL
  `.execute(k.db)
  await sql`
    UPDATE mail_outbox
       SET status = 'failed', message = NULL, last_error = 'expired'
     WHERE status = 'queued' AND expires_at <= now()
  `.execute(k.db)
}

let sweeping = new WeakMap<Kernel, Promise<void>>()

export async function runOutboxSweep(k: Kernel): Promise<void> {
  requireSecret(k, 'sweep the outbox')
  const running = sweeping.get(k)
  if (running) return await running
  const run = (async () => {
    await recoverLeases(k)
    for (let i = 0; i < 50 && !k.stopped; i++) {
      const rows = await claimAndAttempt(k)
      if (rows.length === 0) break
    }
  })()
  sweeping.set(k, run)
  try {
    await run
  } finally {
    sweeping.delete(k)
  }
}

export async function purgeOutbox(k: Kernel): Promise<number> {
  const res = await k.db
    .deleteFrom('mail_outbox')
    .where('status', 'in', ['sent', 'failed'])
    .where(sql<boolean>`coalesce(sent_at, created_at) < now() - interval '7 days'`)
    .executeTakeFirst()
  return Number(res.numDeletedRows)
}

export async function stopOutbox(k: Kernel): Promise<void> {
  k.stopped = true
  if (k.claims.size === 0) return
  await k.db
    .updateTable('mail_outbox')
    .set({ status: 'queued', claimed_by: null, claimed_until: null })
    .where('claimed_by', 'in', [...k.claims])
    .where('status', '=', 'sending')
    .where('attempt_started_at', 'is', null)
    .execute()
}

export function resetSweepState(): void {
  sweeping = new WeakMap()
}
