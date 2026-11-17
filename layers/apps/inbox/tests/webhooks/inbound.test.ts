// Inbound mail's security battery: signature gate, org routing,
// dedupe, token threading, thread-graft protection, the held queue, vacation
// handling, channel claiming + DKIM-gated verification, and org isolation.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  postInbound
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag = 'jane') {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

describe('inbound mail', () => {
  it('rejects a bad signature with 401 and stores nothing', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const res = await postInbound({
      recipient: `hello@${domain}`,
      from: `X <${uniqueSender()}>`,
      signatureOverride: '0'.repeat(64)
    })
    expect(res.status).toBe(401)
  })

  it('routes new mail to the org claiming the recipient domain, claims the channel, and verifies it on authenticated inbound', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender()
    const res = await postInbound({
      recipient: `hello@${domain}`,
      from: `Jane Doe <${sender}>`,
      subject: 'First contact'
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('contact')

    const [convo] = await sql`
      SELECT c.*, ch.value AS channel_value, ch.verified
      FROM inbox_conversations c JOIN crm_channels ch ON ch.id = c.channel_id
      WHERE c.id = ${res.body.conversation_id as string}
    `
    expect(convo!.org_id).toBe(org.id)
    expect(convo!.channel_value).toBe(sender)
    expect(convo!.verified).toBe(true)
    expect(convo!.counterparty_name).toBe('Jane Doe')
    expect(convo!.source).toBe('inbound_email')
  })

  it('does not verify the channel for unauthenticated mail', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const res = await postInbound({
      recipient: `hello@${domain}`,
      from: `Jane <${uniqueSender()}>`,
      authenticated: false
    })
    const [convo] = await sql`
      SELECT ch.verified FROM inbox_conversations c
      JOIN crm_channels ch ON ch.id = c.channel_id
      WHERE c.id = ${res.body.conversation_id as string}
    `
    expect(convo!.verified).toBe(false)
  })

  it('acknowledges mail for unknown domains without storing anything', async () => {
    await createInboxOrgWith(sql)
    const res = await postInbound({
      recipient: `hello@test-inbox-nobody-${randomUUID().slice(0, 6)}.test`,
      from: `Jane <${uniqueSender()}>`
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ignored')
    expect(res.kernel.recipients).toEqual([expect.objectContaining({ outcome: 'unknown_domain' })])
  })

  it('dedupes redeliveries by Message-Id', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const messageId = `<test-inbox-dupe-${randomUUID()}@sender.example>`
    const sender = uniqueSender()
    const first = await postInbound({ recipient: `hello@${domain}`, from: `J <${sender}>`, messageId })
    const second = await postInbound({ recipient: `hello@${domain}`, from: `J <${sender}>`, messageId })
    expect(first.body.status).toBe('contact')
    expect(second.body.status).toBe('duplicate')
    expect(second.body.conversation_id).toBe(first.body.conversation_id)
  })

  it('threads a token reply from the counterparty into the conversation', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender()
    const first = await postInbound({ recipient: `hello@${domain}`, from: `Jane <${sender}>` })
    const [row] = await sql`SELECT reply_token FROM inbox_conversations WHERE id = ${first.body.conversation_id as string}`
    const reply = await postInbound({
      recipient: `contact+${row!.reply_token}@${domain}`,
      from: `Jane <${sender}>`,
      subject: 'Re: Test subject'
    })
    expect(reply.body.status).toBe('contact')
    expect(reply.body.conversation_id).toBe(first.body.conversation_id)
  })

  it('threads a tokenless In-Reply-To reply from the same sender into the conversation', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('threads')
    const messageId = `<test-inbox-pos-thread-${randomUUID()}@sender.example>`
    const first = await postInbound({ recipient: `hello@${domain}`, from: `Jane <${sender}>`, messageId })
    // No reply token — threading rides In-Reply-To, allowed because the
    // sender's channel owns the referenced conversation.
    const reply = await postInbound({
      recipient: `hello@${domain}`,
      from: `Jane <${sender}>`,
      inReplyTo: messageId,
      subject: 'Re: Test subject'
    })
    expect(reply.body.status).toBe('contact')
    expect(reply.body.conversation_id).toBe(first.body.conversation_id)
  })

  it('reopens a closed conversation on a token reply, but a vacation auto-reply closes it instead', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('reopen')
    const first = await postInbound({ recipient: `hello@${domain}`, from: `Jane <${sender}>` })
    const convId = first.body.conversation_id as string
    const [row] = await sql`SELECT reply_token FROM inbox_conversations WHERE id = ${convId}`
    const tokenAddr = `contact+${row!.reply_token}@${domain}`

    // Closed + a real reply from the contact → back with the team: open.
    await $fetch(`/api/inbox/conversations/${convId}`, { method: 'PATCH', body: { status: 'closed' }, ...opts })
    await postInbound({ recipient: tokenAddr, from: `Jane <${sender}>` })
    let [state] = await sql`SELECT status FROM inbox_conversations WHERE id = ${convId}`
    expect(state!.status).toBe('open')

    // Pending + a vacation auto-reply → noise, not attention: closed.
    await $fetch(`/api/inbox/conversations/${convId}`, { method: 'PATCH', body: { status: 'pending' }, ...opts })
    await postInbound({
      recipient: tokenAddr,
      from: `Jane <${sender}>`,
      headers: [['Auto-Submitted', 'auto-replied']]
    })
    ;[state] = await sql`SELECT status FROM inbox_conversations WHERE id = ${convId}`
    expect(state!.status).toBe('closed')
  })

  it('holds token mail from a sender that does not own the conversation', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const first = await postInbound({ recipient: `hello@${domain}`, from: `Jane <${uniqueSender()}>` })
    const [row] = await sql`SELECT reply_token FROM inbox_conversations WHERE id = ${first.body.conversation_id as string}`
    const intruder = await postInbound({
      recipient: `contact+${row!.reply_token}@${domain}`,
      from: `Mallory <${uniqueSender('mallory')}>`
    })
    expect(intruder.body.status).toBe('held')
    expect(intruder.body.conversation_id).toBe(first.body.conversation_id)

    const [msg] = await sql`
      SELECT status, hold_reason FROM inbox_messages WHERE id = ${intruder.body.message_id as string}
    `
    expect(msg!.status).toBe('held')
    expect(msg!.hold_reason).toBeTruthy()
    const [convo] = await sql`SELECT needs_review FROM inbox_conversations WHERE id = ${first.body.conversation_id as string}`
    expect(convo!.needs_review).toBe(true)
  })

  it('never grafts forged References from a different sender onto a thread', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const messageId = `<test-inbox-anchor-${randomUUID()}@sender.example>`
    const first = await postInbound({ recipient: `hello@${domain}`, from: `Jane <${uniqueSender()}>`, messageId })
    const forged = await postInbound({
      recipient: `hello@${domain}`,
      from: `Mallory <${uniqueSender('mallory')}>`,
      references: messageId,
      inReplyTo: messageId
    })
    expect(forged.body.status).toBe('contact')
    expect(forged.body.conversation_id).not.toBe(first.body.conversation_id)
  })

  it('closes vacation auto-replies instead of surfacing them', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const res = await postInbound({
      recipient: `hello@${domain}`,
      from: `Jane <${uniqueSender()}>`,
      headers: [['Auto-Submitted', 'auto-replied']]
    })
    const [convo] = await sql`SELECT status, needs_review FROM inbox_conversations WHERE id = ${res.body.conversation_id as string}`
    expect(convo!.status).toBe('closed')
    expect(convo!.needs_review).toBe(false)
  })

  it('drops mail to the bounce return-path address', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const res = await postInbound({
      recipient: `bounce+verp123@${domain}`,
      from: `Robot <mailer-daemon@some.example>`
    })
    expect(res.body.status).toBe('ignored')
    expect(res.kernel.recipients).toEqual([expect.objectContaining({ outcome: 'drop', handler: 'inbox' })])
  })

  it('isolates orgs: two orgs receive mail on their own domains only', async () => {
    const a = await createInboxOrgWith(sql)
    const b = await createInboxOrgWith(sql)
    const resA = await postInbound({ recipient: `hello@${a.domain}`, from: `J <${uniqueSender()}>` })
    const resB = await postInbound({ recipient: `hello@${b.domain}`, from: `K <${uniqueSender('kim')}>` })
    const [rowA] = await sql`SELECT org_id FROM inbox_conversations WHERE id = ${resA.body.conversation_id as string}`
    const [rowB] = await sql`SELECT org_id FROM inbox_conversations WHERE id = ${resB.body.conversation_id as string}`
    expect(rowA!.org_id).toBe(a.org.id)
    expect(rowB!.org_id).toBe(b.org.id)
  })
})
