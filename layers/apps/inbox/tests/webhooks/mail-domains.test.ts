// Which domain inbox mail uses: an org's own domain only once it can receive
// (replies come back to it); until then the host's inbox domain, where the
// org's address is <slug>@ under slug addresses. The Message-Id the kernel
// sends with is what replies thread on.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  setInboxOrgSetting,
  setMailDomainReceiving,
  postInbound,
  waitForMailsTo,
  INBOX_TEST_SHARED_DOMAIN as SHARED
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

async function replyAndWait(conversationId: string, opts: object): Promise<string> {
  const queued = await $fetch<{ id: string }>(`/api/inbox/conversations/${conversationId}/messages`, {
    method: 'POST', body: { body: `<p>reply ${randomUUID().slice(0, 6)}</p>` }, ...opts
  })
  for (let i = 0; i < 60; i++) {
    const [row] = await sql<{ status: string }[]>`SELECT status FROM inbox_messages WHERE id = ${queued.id}`
    if (row!.status === 'sent') return queued.id
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`reply ${queued.id} was never sent`)
}

describe('inbox mail domains', () => {
  it('replies from the host inbox domain until the org\'s own domain can receive, then from contact@ it', async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const [own] = await sql<{ id: string }[]>`SELECT id FROM mail_domains WHERE org_id = ${org.id}`
    await setMailDomainReceiving(sql, own!.id, false)

    const before = await $fetch<{ mailDomain: string, contactAddress: string }>('/api/inbox/settings', opts)
    expect(before).toMatchObject({ mailDomain: SHARED, contactAddress: `${org.slug}@${SHARED}` })

    // New mail reaches the org at its slug address on the host domain.
    const sender = `test-inbox-domains-${randomUUID().slice(0, 8)}@sender.example`
    const inbound = await postInbound({ recipient: `${org.slug}@${SHARED}`, from: `Dee <${sender}>` })
    expect(inbound.body.status).toBe('contact')
    const convId = inbound.body.conversation_id as string

    await replyAndWait(convId, opts)
    let sent = await waitForMailsTo(sender, 1)
    expect(sent[0]!.from).toContain(`${org.slug}@${SHARED}`)
    expect(sent[0]!.replyTo).toContain(`${org.slug}+`)
    expect(sent[0]!.replyTo).toContain(`@${SHARED}`)

    // Receiving verifies on the org's own domain.
    await setMailDomainReceiving(sql, own!.id, true)
    const after = await $fetch<{ mailDomain: string, contactAddress: string }>('/api/inbox/settings', opts)
    expect(after).toMatchObject({ mailDomain: domain, contactAddress: `contact@${domain}` })

    const second = await replyAndWait(convId, opts)
    sent = await waitForMailsTo(sender, 2)
    expect(sent[0]!.from).toContain(`contact@${domain}`)
    expect(sent[0]!.replyTo).toContain(`@${domain}`)

    // The stored Message-Id is the one the kernel sent with, so a reply that
    // references it threads back.
    const [row] = await sql<{ email_message_id: string }[]>`SELECT email_message_id FROM inbox_messages WHERE id = ${second}`
    expect(row!.email_message_id).toBe(sent[0]!.messageId)
    const threaded = await postInbound({
      recipient: `hello@${domain}`,
      from: `Dee <${sender}>`,
      inReplyTo: row!.email_message_id,
      subject: 'Re: thanks'
    })
    expect(threaded.body.conversation_id).toBe(convId)
  })

  it('sends a personal reply from the alias on the org\'s own domain', async () => {
    const { org, user, opts, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    await $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { alias: 'dana' }, ...opts })
    const sender = `test-inbox-alias-${randomUUID().slice(0, 8)}@sender.example`
    const inbound = await postInbound({ recipient: `hello@${domain}`, from: `Ali <${sender}>` })

    await $fetch(`/api/inbox/conversations/${inbound.body.conversation_id as string}/messages`, {
      method: 'POST', body: { body: '<p>personal</p>', fromIdentity: 'personal' }, ...opts
    })
    const [mail] = await waitForMailsTo(sender)
    expect(mail!.from).toContain(`dana@${domain}`)
  })
})
