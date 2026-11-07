// The delivery-events webhook: bounce → crm suppression, complaint → crm
// suppression, unsubscribe → marketing consent opt-out with a null actor,
// delivered → message state. The sweep-side effect of suppression (a queued
// reply failing instead of sending) is pinned in tests/api/send-sweep.test.ts.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  setInboxOrgSetting,
  postInbound,
  postDeliveryEvent
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

describe('delivery events webhook', () => {
  it('suppresses the channel on a permanent failure (org-anchored via user variable)', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('bouncer')
    await postInbound({ recipient: `hello@${domain}`, from: `B <${sender}>` })

    const res = await postDeliveryEvent({
      event: 'failed',
      severity: 'permanent',
      recipient: sender,
      reason: 'mailbox full forever',
      'delivery-status': { message: '550 5.1.1 user unknown' },
      'user-variables': { 'inbox-org': org.id }
    })
    expect(res.suppressed).toBe(true)

    const [row] = await sql`
      SELECT s.reason, s.detail, ch.value FROM crm_channel_suppressions s
      JOIN crm_channels ch ON ch.id = s.channel_id
      WHERE ch.value = ${sender}
    `
    expect(row!.reason).toBe('hard_bounce')
    expect(row!.detail).toContain('550')
  })

  it('does not suppress on a transient failure', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('greylist')
    await postInbound({ recipient: `hello@${domain}`, from: `G <${sender}>` })

    await postDeliveryEvent({
      event: 'failed',
      severity: 'temporary',
      recipient: sender,
      'user-variables': { 'inbox-org': org.id }
    })
    const rows = await sql`
      SELECT s.id FROM crm_channel_suppressions s
      JOIN crm_channels ch ON ch.id = s.channel_id WHERE ch.value = ${sender}
    `
    expect(rows.length).toBe(0)
  })

  it('flips marketing consent on unsubscribe with a null actor, without suppressing', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('unsub')
    await postInbound({ recipient: `hello@${domain}`, from: `U <${sender}>` })

    const res = await postDeliveryEvent({
      event: 'unsubscribed',
      recipient: sender,
      'user-variables': { 'inbox-org': org.id }
    })
    expect(res.unsubscribed).toBe(true)

    const [consent] = await sql`
      SELECT cc.purpose, cc.status FROM crm_channel_consents cc
      JOIN crm_channels ch ON ch.id = cc.channel_id WHERE ch.value = ${sender}
    `
    expect(consent!.purpose).toBe('marketing')
    expect(consent!.status).toBe('opt_out')

    const [event] = await sql`
      SELECT e.event, e.actor_user_id, e.source FROM crm_consent_events e
      JOIN crm_channels ch ON ch.id = e.channel_id WHERE ch.value = ${sender}
    `
    expect(event!.event).toBe('revoke')
    expect(event!.actor_user_id).toBeNull()
    expect(event!.source).toBe('mailgun')

    const suppressions = await sql`
      SELECT s.id FROM crm_channel_suppressions s
      JOIN crm_channels ch ON ch.id = s.channel_id WHERE ch.value = ${sender}
    `
    expect(suppressions.length).toBe(0)
  })

  it('ignores events for addresses no scope has claimed', async () => {
    await createInboxOrgWith(sql)
    const res = await postDeliveryEvent({
      event: 'complained',
      recipient: uniqueSender('stranger')
    })
    expect(res.status).toBe('failed')
    expect(res.suppressed).toBeFalsy()
  })

  it("flips the message to 'delivered' by provider id without ever verifying the channel", async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const sender = uniqueSender('delivered')
    // Unauthenticated inbound so the channel starts (and must stay) unverified.
    const inbound = await postInbound({ recipient: `hello@${domain}`, from: `D <${sender}>`, authenticated: false })
    const convId = inbound.body.conversation_id as string

    const queued = await $fetch<{ id: string }>(`/api/inbox/conversations/${convId}/messages`, {
      method: 'POST', body: { body: '<p>reply</p>' }, ...opts
    })

    // The 2s sweep sends it; wait for the provider message id.
    let providerId = ''
    for (let i = 0; i < 60 && !providerId; i++) {
      const [row] = await sql`SELECT status, provider_message_id FROM inbox_messages WHERE id = ${queued.id}`
      if (row!.status === 'sent' && row!.provider_message_id) providerId = row!.provider_message_id as string
      else await new Promise(r => setTimeout(r, 250))
    }
    expect(providerId).toBeTruthy()

    const res = await postDeliveryEvent({
      event: 'delivered',
      recipient: sender,
      message: { headers: { 'message-id': providerId.replace(/^<|>$/g, '') } },
      'user-variables': { 'inbox-org': org.id }
    })
    expect(res.status).toBe('delivered')
    expect(res.matched).toBe(true)

    const [msg] = await sql`SELECT status FROM inbox_messages WHERE id = ${queued.id}`
    expect(msg!.status).toBe('delivered')

    // Delivery success is not ownership proof — only authenticated inbound
    // mail verifies a channel.
    const [ch] = await sql`SELECT verified FROM crm_channels WHERE value = ${sender}`
    expect(ch!.verified).toBe(false)

    // The state flip leaves a conversation-timeline trace.
    const trail = await $fetch<{ items: Array<{ eventType: string }> }>(
      `/api/inbox/conversations/${convId}/activity`, opts
    )
    expect(trail.items.some(i => i.eventType === 'inbox_delivery_delivered')).toBe(true)
  })

  it('writes a record-timeline entry when a linked contact is suppressed or unsubscribes', async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('timeline')
    const inbound = await postInbound({ recipient: `hello@${domain}`, from: `T <${sender}>` })
    const convId = inbound.body.conversation_id as string

    // Link a CRM record to the conversation's channel.
    const record = await $fetch<{ id: string }>(`/api/inbox/conversations/${convId}/contact`, {
      method: 'POST', body: { name: 'test-inbox Timeline' }, ...opts
    })

    await postDeliveryEvent({
      event: 'failed',
      severity: 'permanent',
      recipient: sender,
      'delivery-status': { message: '550 gone' },
      'user-variables': { 'inbox-org': org.id }
    })
    await postDeliveryEvent({
      event: 'unsubscribed',
      recipient: sender,
      'user-variables': { 'inbox-org': org.id }
    })

    const rows = await sql`
      SELECT action, note, actor_label, actor_user_id FROM records_activity
      WHERE record_id = ${record.id} AND action IN ('email_suppressed', 'unsubscribed')
      ORDER BY action
    `
    expect(rows.map(r => r.action)).toEqual(['email_suppressed', 'unsubscribed'])
    expect(rows[0]!.note).toContain('hard bounce')
    expect(rows[0]!.actor_label).toBe('Mailgun')
    expect(rows[0]!.actor_user_id).toBeNull()
  })

  it("a complaint after delivery suppresses the address but leaves the message 'delivered'", async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const sender = uniqueSender('spamflag')
    const inbound = await postInbound({ recipient: `hello@${domain}`, from: `S <${sender}>` })
    const convId = inbound.body.conversation_id as string

    const queued = await $fetch<{ id: string }>(`/api/inbox/conversations/${convId}/messages`, {
      method: 'POST', body: { body: '<p>reply</p>' }, ...opts
    })

    let providerId = ''
    for (let i = 0; i < 60 && !providerId; i++) {
      const [row] = await sql`SELECT status, provider_message_id FROM inbox_messages WHERE id = ${queued.id}`
      if (row!.status === 'sent' && row!.provider_message_id) providerId = row!.provider_message_id as string
      else await new Promise(r => setTimeout(r, 250))
    }
    expect(providerId).toBeTruthy()
    const messageIdHeader = { headers: { 'message-id': providerId.replace(/^<|>$/g, '') } }

    await postDeliveryEvent({
      event: 'delivered',
      recipient: sender,
      message: messageIdHeader,
      'user-variables': { 'inbox-org': org.id }
    })

    const res = await postDeliveryEvent({
      event: 'complained',
      recipient: sender,
      message: messageIdHeader,
      'user-variables': { 'inbox-org': org.id }
    })
    expect(res.suppressed).toBe(true)

    // The recipient DID receive the mail — the complaint must not rewrite
    // delivery state, only suppress the address.
    const [msg] = await sql`SELECT status FROM inbox_messages WHERE id = ${queued.id}`
    expect(msg!.status).toBe('delivered')

    const suppressions = await sql`
      SELECT s.reason FROM crm_channel_suppressions s
      JOIN crm_channels ch ON ch.id = s.channel_id WHERE ch.value = ${sender}
    `
    expect(suppressions.length).toBe(1)
    expect(suppressions[0]!.reason).toBe('complaint')
  })

  it('absorbs a repeated complaint idempotently — one suppression row', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('complainer')
    await postInbound({ recipient: `hello@${domain}`, from: `C <${sender}>` })

    for (let i = 0; i < 2; i++) {
      const res = await postDeliveryEvent({
        event: 'complained',
        recipient: sender,
        'user-variables': { 'inbox-org': org.id }
      })
      expect(res.suppressed).toBe(true)
    }

    const rows = await sql`
      SELECT s.reason FROM crm_channel_suppressions s
      JOIN crm_channels ch ON ch.id = s.channel_id WHERE ch.value = ${sender}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.reason).toBe('complaint')
  })
})
