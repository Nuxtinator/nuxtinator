// Send-sweep hardening battery — pins the five safety behaviors of the
// outbound machinery (inbox-send-processor.ts + inbox-messages.ts):
//   1. a queued reply to a suppressed channel goes 'failed', never sent
//   2. staff reply bodies are sanitized at write (script/handler stripped)
//   3. the atomic claim guard: repeated sweep ticks deliver exactly once
//   4. missing configuration holds rather than fails: a queued reply with no
//      contact address keeps its status and its attempt budget indefinitely,
//      and goes out on its own once the address is set
//   5. a held sender's address never becomes the recipient (or thread anchor,
//      or quoted content) of a staff reply
// The sweep runs every 2s here (INBOX_SEND_SWEEP_SECONDS pinned in
// global-setup.ts), so queued→terminal transitions are observable in-test.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  setInboxOrgSetting,
  postInbound,
  postDeliveryEvent,
  waitForMailTo
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

// Mailpit search — exact recipient match, unaffected by other projects'
// parallel mail volume (unlike the first-page-only list endpoint).
async function mailsTo(email: string): Promise<Array<{ id: string, body: string }>> {
  const base = process.env.TEST_MAILHOG_URL || 'http://localhost:8025'
  const res = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`)
  const body = await res.json() as { messages: Array<{ ID: string, To: Array<{ Address: string }> }> }
  const matches = (body.messages ?? []).filter(m =>
    m.To.some(t => t.Address.toLowerCase() === email.toLowerCase())
  )
  const out: Array<{ id: string, body: string }> = []
  for (const m of matches) {
    const full = await fetch(`${base}/api/v1/message/${m.ID}`)
    const parsed = await full.json() as { Text: string, HTML: string }
    out.push({ id: m.ID, body: `${parsed.Text}\n${parsed.HTML}` })
  }
  return out
}

async function mailCountTo(email: string): Promise<number> {
  return (await mailsTo(email)).length
}

interface MessageRow {
  status: string
  attempts: number
  hold_reason: string | null
  failed_reason: string | null
  next_attempt_at: Date | null
  body_html: string | null
  body_text: string | null
}

async function getMessageRow(id: string): Promise<MessageRow> {
  const [row] = await sql`
    SELECT status, attempts, hold_reason, failed_reason, next_attempt_at, body_html, body_text
    FROM inbox_messages WHERE id = ${id}
  `
  if (!row) throw new Error(`message ${id} not found`)
  return row as unknown as MessageRow
}

// Poll until the row satisfies `until` or the timeout elapses (the sweep tick
// is 2s, so terminal states land within a tick or two).
async function waitForMessage(
  id: string,
  until: (row: MessageRow) => boolean,
  timeoutMs = 15_000
): Promise<MessageRow> {
  const start = Date.now()
  let last: MessageRow | null = null
  while (Date.now() - start < timeoutMs) {
    last = await getMessageRow(id)
    if (until(last)) return last
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`message ${id} never reached the expected state; last: ${JSON.stringify(last)}`)
}

async function queueReply(conversationId: string, opts: object, body = '<p>On it.</p>'): Promise<string> {
  const res = await $fetch<{ id: string, status: string }>(
    `/api/inbox/conversations/${conversationId}/messages`,
    { method: 'POST', body: { body }, ...opts }
  )
  expect(res.status).toBe('queued')
  return res.id
}

// The composer route refuses replies it knows can't be delivered, so a reply
// that becomes undeliverable after queueing is inserted straight into the
// queue: the sweep must still catch it.
async function insertQueuedReply(orgId: string, conversationId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO inbox_messages (org_id, conversation_id, direction, status, body_html, body_text)
    VALUES (${orgId}, ${conversationId}, 'outbound', 'queued', '<p>On it.</p>', 'On it.')
    RETURNING id
  `
  return row!.id
}

describe('send sweep hardening', () => {
  it('fails a queued reply to a suppressed channel without sending', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const sender = uniqueSender('suppressed')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `S <${sender}>` })

    // Hard bounce → deliverability suppression on the sender's channel.
    const supp = await postDeliveryEvent({
      event: 'failed',
      severity: 'permanent',
      recipient: sender,
      'delivery-status': { message: '550 5.1.1 user unknown' },
      'user-variables': { 'inbox-org': org.id }
    })
    expect(supp.suppressed).toBe(true)

    const msgId = await insertQueuedReply(org.id, res.body.conversation_id as string)
    const row = await waitForMessage(msgId, r => r.status === 'failed')
    expect(row.failed_reason).toBe('Recipient suppressed')
    // The row failed before any claim/send was attempted — nothing went out.
    expect(row.attempts).toBe(0)
    expect(await mailCountTo(sender)).toBe(0)
  })

  it('sanitizes the staff reply body at write time', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const res = await postInbound({ recipient: `hello@${domain}`, from: `S <${uniqueSender('sanitize')}>` })

    const msgId = await queueReply(
      res.body.conversation_id as string,
      opts,
      `<p>hi</p><script>alert('xss')</script><img src="x" onerror="alert(1)"><a href="javascript:alert(2)">x</a>`
    )
    const row = await getMessageRow(msgId)
    expect(row.body_html).toContain('<p>hi</p>')
    expect(row.body_html).not.toContain('<script')
    expect(row.body_html).not.toContain('alert(')
    expect(row.body_html).not.toContain('onerror')
    expect(row.body_html).not.toContain('javascript:')
    expect(row.body_text).not.toContain('alert(')
  })

  it('delivers a queued reply exactly once across repeated sweep ticks', async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const sender = uniqueSender('once')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `O <${sender}>` })

    const msgId = await queueReply(res.body.conversation_id as string, opts)
    await waitForMailTo(sender, 15_000)

    // Two more sweep periods: a broken claim (row still 'queued', or sent
    // rows re-picked) would deliver again on these ticks.
    await new Promise(r => setTimeout(r, 5_000))
    expect(await mailCountTo(sender)).toBe(1)
    const row = await getMessageRow(msgId)
    expect(row.status).toBe('sent')
    expect(row.attempts).toBe(1)
  })

  it('holds a queued reply while no contact address is set, then sends it once one is', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const sender = uniqueSender('hold')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `R <${sender}>` })

    // Remove the From identity — nothing can send until an operator restores
    // it, which is a configuration state rather than a delivery failure.
    await sql`
      DELETE FROM core_settings
      WHERE org_id = ${org.id} AND namespace = 'inbox' AND key = 'contact_address'
    `
    const msgId = await insertQueuedReply(org.id, res.body.conversation_id as string)

    // The sweep holds it: still queued, no attempt spent, reason recorded,
    // and nothing delivered.
    const held = await waitForMessage(msgId, r => r.hold_reason !== null)
    expect(held.status).toBe('queued')
    expect(held.attempts).toBe(0)
    expect(held.failed_reason).toBeNull()
    expect(held.hold_reason).toBe('Inbox contact address not configured')
    expect(await mailCountTo(sender)).toBe(0)

    // Repeated sweeps must not age it toward 'failed' — the whole point is
    // that a missing setting never exhausts the retry budget. Pull the
    // recheck time back so several more ticks actually examine the row.
    for (let i = 0; i < 3; i++) {
      await sql`UPDATE inbox_messages SET next_attempt_at = now() - interval '1 second' WHERE id = ${msgId}`
      await new Promise(r => setTimeout(r, 2_500))
      const still = await getMessageRow(msgId)
      expect(still.status).toBe('queued')
      expect(still.attempts).toBe(0)
    }

    // Configuring the address releases it with no manual intervention. (The
    // hold pushes next_attempt_at a minute out; the test pulls it back rather
    // than waiting for the production recheck interval.)
    await setInboxOrgSetting(sql, org.id, 'contact_address', `contact@${domain}`)
    await sql`UPDATE inbox_messages SET next_attempt_at = now() - interval '1 second' WHERE id = ${msgId}`

    const sent = await waitForMessage(msgId, r => r.status === 'sent')
    expect(sent.hold_reason).toBeNull()
    expect(sent.attempts).toBe(1)
    await waitForMailTo(sender)
  })

  it('never sends a staff reply to a held sender, anchors it to them, or quotes their content', async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const jane = uniqueSender('jane')
    const mallory = uniqueSender('mallory')
    const janeMessageId = `<test-inbox-jane-${randomUUID()}@sender.example>`
    const JANE_MARKER = `contact-content-${randomUUID().slice(0, 8)}`
    const MALLORY_MARKER = `intruder-content-${randomUUID().slice(0, 8)}`
    const STAFF_MARKER = `staff-reply-${randomUUID().slice(0, 8)}`

    const first = await postInbound({
      recipient: `hello@${domain}`,
      from: `Jane <${jane}>`,
      subject: 'Legit question',
      text: JANE_MARKER,
      messageId: janeMessageId
    })
    const convId = first.body.conversation_id as string

    // Mallory reaches the thread with a valid reply token but a From that
    // doesn't own the conversation → held. An authenticated held sender gets
    // a boilerplate "waiting for review" courtesy notice at intake — wait for
    // it so the later exactly-one assertion can't race it.
    const [conv] = await sql`SELECT reply_token FROM inbox_conversations WHERE id = ${convId}`
    const intruder = await postInbound({
      recipient: `contact+${conv!.reply_token}@${domain}`,
      from: `Mallory <${mallory}>`,
      text: MALLORY_MARKER
    })
    expect(intruder.body.status).toBe('held')
    await waitForMailTo(mallory, 15_000)

    const msgId = await queueReply(convId, opts, `<p>${STAFF_MARKER}</p>`)
    const mail = await waitForMailTo(jane, 15_000)

    // Recipient is the channel owner, not the held sender — and the held
    // message never becomes the threading anchor or part of the quoted
    // history.
    expect(mail.to).toEqual([jane])
    expect(mail.body).toContain(STAFF_MARKER)
    expect(mail.body).not.toContain(MALLORY_MARKER)
    const base = process.env.TEST_MAILHOG_URL || 'http://localhost:8025'
    const headersRes = await fetch(`${base}/api/v1/message/${mail.id}/headers`)
    const headers = await headersRes.json() as Record<string, string[]>
    const header = (name: string) => headers[name]?.[0] ?? headers[name.toLowerCase()]?.[0] ?? ''
    expect(header('In-Reply-To')).toBe(janeMessageId)

    // Mallory got exactly the intake courtesy notice and nothing more: the
    // staff reply never went to her, and no thread content leaked into it.
    const malloryMail = await mailsTo(mallory)
    expect(malloryMail).toHaveLength(1)
    expect(malloryMail[0]!.body).not.toContain(STAFF_MARKER)
    expect(malloryMail[0]!.body).not.toContain(JANE_MARKER)

    const row = await getMessageRow(msgId)
    expect(row.status).toBe('sent')
  })
})
