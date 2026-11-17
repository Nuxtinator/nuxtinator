// Delivery events for inbox mail, posted through the fake provider's events
// URL: delivered → message state, permanent failures → failed (never over
// delivered), the kernel's suppression list on a bounce, and the trust rule
// that an event only reaches messages of the org it names.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, url as nuxtUrl } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import { fakeSignature } from '@nuxtinator/mail/test'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  setInboxOrgSetting,
  postInbound,
  postMailEvents,
  hashMailAddress
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

async function messageRow(id: string) {
  const [row] = await sql<{ status: string, failed_reason: string | null, provider_message_id: string | null, delivered_at: Date | null }[]>`
    SELECT status, failed_reason, provider_message_id, delivered_at FROM inbox_messages WHERE id = ${id}
  `
  return row!
}

// A conversation with one staff reply the sweep has sent.
async function sentReply(opts: { authenticated?: boolean } = {}) {
  const ctx = await createInboxOrgWith(sql)
  await setInboxOrgSetting(sql, ctx.org.id, 'auto_ack_enabled', false)
  const sender = uniqueSender('delivery')
  const inbound = await postInbound({ recipient: `hello@${ctx.domain}`, from: `D <${sender}>`, authenticated: opts.authenticated })
  const convId = inbound.body.conversation_id as string
  const queued = await $fetch<{ id: string }>(`/api/inbox/conversations/${convId}/messages`, {
    method: 'POST', body: { body: '<p>reply</p>' }, ...ctx.opts
  })
  for (let i = 0; i < 60; i++) {
    const row = await messageRow(queued.id)
    if (row.status === 'sent' && row.provider_message_id) break
    await new Promise(r => setTimeout(r, 250))
  }
  expect((await messageRow(queued.id)).status).toBe('sent')
  return { ...ctx, sender, convId, messageId: queued.id }
}

describe('delivery events', () => {
  it("flips the message to 'delivered' by ref without ever verifying the channel", async () => {
    // Unauthenticated inbound so the channel starts (and must stay) unverified.
    const { org, opts, sender, convId, messageId } = await sentReply({ authenticated: false })

    const res = await postMailEvents([{ type: 'delivered', recipient: sender, orgId: org.id, ref: messageId }])
    expect(res.status).toBe(200)

    const msg = await messageRow(messageId)
    expect(msg.status).toBe('delivered')
    expect(msg.delivered_at).toBeTruthy()

    // Delivery success is not ownership proof — only authenticated inbound
    // mail verifies a channel.
    const [ch] = await sql`SELECT verified FROM crm_channels WHERE value = ${sender}`
    expect(ch!.verified).toBe(false)

    // The state flip leaves a conversation-timeline trace.
    const trail = await $fetch<{ items: Array<{ eventType: string }> }>(`/api/inbox/conversations/${convId}/activity`, opts)
    expect(trail.items.some(i => i.eventType === 'inbox_delivery_delivered')).toBe(true)
  })

  it('fails the message on a permanent bounce, and the kernel suppresses the address', async () => {
    const { org, opts, sender, convId, messageId } = await sentReply()

    await postMailEvents([{ type: 'bounced', recipient: sender, detail: '550 5.1.1 user unknown', orgId: org.id, ref: messageId }])

    const msg = await messageRow(messageId)
    expect(msg.status).toBe('failed')
    expect(msg.failed_reason).toContain('550')

    const [supp] = await sql`
      SELECT reason, scope FROM mail_suppressions WHERE address_hash = ${hashMailAddress(sender)} AND cleared_at IS NULL
    `
    expect(supp).toMatchObject({ reason: 'hard_bounce', scope: 'global' })

    // CRM's suppression check includes the kernel's list: further replies are refused.
    await expect($fetch(`/api/inbox/conversations/${convId}/messages`, {
      method: 'POST', body: { body: '<p>again</p>' }, ...opts
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('never downgrades a delivered message, and a complaint leaves it delivered', async () => {
    const { org, sender, messageId } = await sentReply()
    await postMailEvents([{ type: 'delivered', recipient: sender, orgId: org.id, ref: messageId }])
    await postMailEvents([{ type: 'complained', recipient: sender, orgId: org.id, ref: messageId }])
    await postMailEvents([{ type: 'bounced', recipient: sender, orgId: org.id, ref: messageId }])
    expect((await messageRow(messageId)).status).toBe('delivered')
  })

  it('ignores transient failures', async () => {
    const { org, sender, messageId } = await sentReply()
    await postMailEvents([{ type: 'deferred', recipient: sender, orgId: org.id, ref: messageId }])
    expect((await messageRow(messageId)).status).toBe('sent')
  })

  it("only touches the named org's messages", async () => {
    const { sender, messageId } = await sentReply()
    const other = await createInboxOrgWith(sql)
    await postMailEvents([{ type: 'delivered', recipient: sender, orgId: other.org.id, ref: messageId }])
    await postMailEvents([{ type: 'delivered', recipient: sender, orgId: null, ref: messageId }])
    expect((await messageRow(messageId)).status).toBe('sent')
  })

  it('ignores events for other streams', async () => {
    const { org, sender, messageId } = await sentReply()
    await postMailEvents([{ type: 'delivered', recipient: sender, orgId: org.id, ref: messageId, stream: 'system' }])
    expect((await messageRow(messageId)).status).toBe('sent')
  })
})

// An org's own provider account holds its own signing key, so it can sign any
// event; the kernel hands handlers the account's org instead of the one named.
describe('events from an org-owned account', () => {
  async function marketingOptIn(orgId: string, address: string): Promise<string> {
    const [channel] = await sql<{ id: string }[]>`SELECT id FROM crm_channels WHERE org_id = ${orgId} AND value = ${address}`
    await sql`
      INSERT INTO crm_channel_consents (org_id, channel_id, purpose, status, granted_at, source)
      VALUES (${orgId}, ${channel!.id}, 'marketing', 'opt_in', now(), 'test')
    `
    return channel!.id
  }

  async function consent(channelId: string): Promise<string> {
    const [row] = await sql<{ status: string }[]>`SELECT status FROM crm_channel_consents WHERE channel_id = ${channelId} AND purpose = 'marketing'`
    return row!.status
  }

  it('a forged nx-org changes nothing in that org: neither the inbox delivery state nor CRM consent', async () => {
    const victim = await sentReply()
    const victimChannel = await marketingOptIn(victim.org.id, victim.sender)

    const attacker = await createInboxOrgWith(sql)
    const signingKey = `test-inbox-org-${randomUUID().slice(0, 8)}`
    const { account } = await $fetch<{ account: { webhookUrls: { events: string } } }>(`/api/o/${attacker.org.slug}/mail/accounts`, {
      method: 'POST',
      body: { provider: 'fake', label: 'test-inbox-org', credentials: { apiKey: 'k', signingKey } },
      ...attacker.auth
    })
    const ownSender = uniqueSender('own')
    await postInbound({ recipient: `hello@${attacker.domain}`, from: `O <${ownSender}>` })
    const ownChannel = await marketingOptIn(attacker.org.id, ownSender)

    const at = new Date().toISOString()
    const body = JSON.stringify({
      events: [
        { type: 'delivered', recipient: victim.sender, orgId: victim.org.id, ref: victim.messageId, stream: 'inbox', permanent: false, occurredAt: at },
        { type: 'unsubscribed', recipient: victim.sender, orgId: victim.org.id, stream: 'inbox', permanent: false, occurredAt: at },
        { type: 'unsubscribed', recipient: ownSender, orgId: victim.org.id, stream: 'inbox', permanent: false, occurredAt: at }
      ]
    })
    const res = await fetch(nuxtUrl(new URL(account.webhookUrls.events).pathname), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fake-signature': fakeSignature(signingKey, body) },
      body
    })
    expect(res.status).toBe(200)

    expect((await messageRow(victim.messageId)).status).toBe('sent')
    expect(await consent(victimChannel)).toBe('opt_in')
    // The handler did run, in the account's own org.
    expect(await consent(ownChannel)).toBe('opt_out')
  })
})

