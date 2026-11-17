// Triage API: list/counts filters, detail payload, status + assignment
// mutations, the spam verdict round-trip, create-contact, org isolation, and
// the queued-reply → send-sweep → Mailpit loop.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  setInboxOrgSetting,
  postInbound,
  withOrgHeader,
  waitForMailTo
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag = 'contact') {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

interface ListResponse {
  items: Array<{ id: string, status: string, needsReview: boolean, counterpartyName: string | null }>
  total: number
}

describe('triage API', () => {
  it('lists conversations with counts and isolates orgs', async () => {
    const a = await createInboxOrgWith(sql)
    const b = await createInboxOrgWith(sql)
    const res = await postInbound({ recipient: `hello@${a.domain}`, from: `Jane <${uniqueSender()}>` })

    const listA = await $fetch<ListResponse>('/api/inbox/conversations', a.opts)
    expect(listA.items.map(i => i.id)).toContain(res.body.conversation_id)

    const listB = await $fetch<ListResponse>('/api/inbox/conversations', b.opts)
    expect(listB.total).toBe(0)

    const counts = await $fetch<{ all: number, open: number }>('/api/inbox/conversations/counts', a.opts)
    expect(counts.all).toBeGreaterThanOrEqual(1)
  })

  it('serves the detail payload with channel, messages, and capabilities', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender()
    const res = await postInbound({ recipient: `hello@${domain}`, from: `Jane Doe <${sender}>`, subject: 'Hello' })

    const detail = await $fetch<{
      conversation: { subject: string | null }
      channel: { value: string, verified: boolean }
      messages: Array<{ direction: string, bodyHtml: string | null }>
      capabilities: { canSend: boolean }
    }>(`/api/inbox/conversations/${res.body.conversation_id}`, opts)

    expect(detail.conversation.subject).toBe('Hello')
    expect(detail.channel.value).toBe(sender)
    expect(detail.channel.verified).toBe(true)
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0]!.direction).toBe('inbound')
    expect(detail.capabilities.canSend).toBe(true)
  })

  it('patches status and assignment; closing clears the review flag', async () => {
    const { opts, user, domain } = await createInboxOrgWith(sql)
    const res = await postInbound({ recipient: `hello@${domain}`, from: `J <${uniqueSender()}>` })
    const id = res.body.conversation_id as string

    await $fetch(`/api/inbox/conversations/${id}`, {
      method: 'PATCH',
      body: { assignedUserId: user.id, needsReview: true },
      ...opts
    })
    const flagged = await $fetch<{ needsReview: boolean, assignedUserId: string }>(`/api/inbox/conversations/${id}`, opts)
      .then(d => (d as unknown as { conversation: { needsReview: boolean, assignedUserId: string } }).conversation)
    expect(flagged.assignedUserId).toBe(user.id)
    expect(flagged.needsReview).toBe(true)

    const closed = await $fetch<{ status: string, needsReview: boolean }>(`/api/inbox/conversations/${id}`, {
      method: 'PATCH',
      body: { status: 'closed' },
      ...opts
    })
    expect(closed.status).toBe('closed')
    expect(closed.needsReview).toBe(false)
  })

  it('marks spam (blocks the sender, files future mail silently) and reverses it', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('spammer')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `S <${sender}>` })
    const id = res.body.conversation_id as string

    const spam = await $fetch<{ status: string }>(`/api/inbox/conversations/${id}`, {
      method: 'PATCH',
      body: { status: 'spam' },
      ...opts
    })
    expect(spam.status).toBe('spam')

    // Follow-up mail from the blocked sender lands in the spam thread.
    const followUp = await postInbound({ recipient: `hello@${domain}`, from: `S <${sender}>` })
    expect(followUp.body.status).toBe('spam')

    // Unblocking reopens as closed (triage queue must not flood).
    const unspam = await $fetch<{ status: string }>(`/api/inbox/conversations/${id}`, {
      method: 'PATCH',
      body: { status: 'closed' },
      ...opts
    })
    expect(unspam.status).toBe('closed')
    const blocked = await sql`
      SELECT b.id FROM inbox_blocked_senders b
      JOIN crm_channels ch ON ch.id = b.channel_id WHERE ch.value = ${sender}
    `
    expect(blocked.length).toBe(0)
  })

  it('creates a CRM contact wired to the conversation channel', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('newcontact')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `Nora <${sender}>` })

    const record = await $fetch<{ id: string, name: string }>(
      `/api/inbox/conversations/${res.body.conversation_id}/contact`,
      { method: 'POST', body: { name: 'test-inbox Nora' }, ...opts }
    )
    expect(record.name).toBe('test-inbox Nora')

    const detail = await $fetch<{ contacts: Array<{ id: string }> }>(
      `/api/inbox/conversations/${res.body.conversation_id}`, opts
    )
    expect(detail.contacts.map(c => c.id)).toContain(record.id)
  })

  it('queues a reply, the sweep sends it via Mailpit with token Reply-To and threading headers', async () => {
    const { opts, org, domain } = await createInboxOrgWith(sql)
    // Auto-ack off so the only mail to the sender is the staff reply —
    // otherwise waitForMailTo grabs the ack (no threading headers) first.
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const sender = uniqueSender('replyto')
    const inboundMessageId = `<test-inbox-thread-${randomUUID()}@sender.example>`
    const res = await postInbound({
      recipient: `hello@${domain}`,
      from: `Jane <${sender}>`,
      subject: 'Need help',
      messageId: inboundMessageId
    })
    const id = res.body.conversation_id as string

    const queued = await $fetch<{ id: string, status: string }>(`/api/inbox/conversations/${id}/messages`, {
      method: 'POST',
      body: { body: '<p>Happy to help!</p>' },
      ...opts
    })
    expect(queued.status).toBe('queued')

    const mail = await waitForMailTo(sender, 15_000)
    // CapturedMessage doesn't carry headers — pull them from Mailpit directly.
    const headersRes = await fetch(`${process.env.TEST_MAILHOG_URL || 'http://localhost:8025'}/api/v1/message/${mail.id}/headers`)
    const headers = await headersRes.json() as Record<string, string[]>
    const header = (name: string) => headers[name]?.[0] ?? headers[name.toLowerCase()]?.[0] ?? ''
    expect(header('Reply-To')).toContain(`@${domain}`)
    expect(header('In-Reply-To')).toBe(inboundMessageId)

    const [row] = await sql`SELECT status, provider_message_id, email_message_id FROM inbox_messages WHERE id = ${queued.id}`
    expect(row!.status).toBe('sent')
    // The RFC Message-Id threads; the provider's own id (none under the smtp
    // transport these tests run on) is kept apart from it.
    expect(row!.email_message_id).toBe(Object.entries(headers).find(([k]) => k.toLowerCase() === 'message-id')?.[1]?.[0])
    expect(row!.provider_message_id).toBeNull()

    // Conversation flipped to pending and auto-assigned to the replier.
    const detail = await $fetch<{ conversation: { status: string, assignedUserId: string | null } }>(
      `/api/inbox/conversations/${id}`, opts
    )
    expect(detail.conversation.status).toBe('pending')
    expect(detail.conversation.assignedUserId).toBeTruthy()
  })

  it('records a conversation activity trail readable via the activity endpoint', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const res = await postInbound({ recipient: `hello@${domain}`, from: `A <${uniqueSender('trail')}>` })
    const id = res.body.conversation_id as string

    await $fetch(`/api/inbox/conversations/${id}`, { method: 'PATCH', body: { status: 'closed' }, ...opts })

    const trail = await $fetch<{ items: Array<{ eventType: string, message: string | null }> }>(
      `/api/inbox/conversations/${id}/activity`, opts
    )
    const types = trail.items.map(i => i.eventType)
    // Inbound created two origin rows; the triage patch added a status row.
    expect(types).toContain('inbox_conversation_created')
    expect(types).toContain('inbox_inbound_received')
    expect(types).toContain('inbox_status_changed')
    // Newest-first: the status change is the most recent event.
    expect(trail.items[0]!.eventType).toBe('inbox_status_changed')
    expect(trail.items[0]!.message).toBe('Status → closed')
  })

  it('denies triage across orgs and to roles without inbox grants', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const res = await postInbound({ recipient: `hello@${domain}`, from: `J <${uniqueSender()}>` })

    // Admin of ANOTHER org: full inbox perms there, but the conversation is
    // invisible through their org scope.
    const outsider = await createInboxOrgWith(sql, ['admin'])
    await expect(
      $fetch(`/api/inbox/conversations/${res.body.conversation_id}`, outsider.opts)
    ).rejects.toMatchObject({ statusCode: 404 })

    // Plain member role: the inbox grants nothing to members by default.
    const member = await createInboxOrgWith(sql, ['member'])
    const memberOpts = withOrgHeader(member.auth, member.org.slug)
    await expect(
      $fetch('/api/inbox/conversations', memberOpts)
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
