// Durable-ack contract of inbound mail: an artifact-persistence failure
// (injected via the VITEST-only X-Test-Fail header seam) deletes the claim
// row and the webhook answers a retryable 503, and the provider's redelivery
// converges on ONE conversation with ONE message. Mail without a sender is
// dropped.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  postInbound
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

describe('inbound durability', () => {
  it('503s on a persistence failure and the retry converges on one conversation, one message', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('retry')
    const messageId = `<test-inbox-durable-${randomUUID()}@sender.example>`

    const failed = await postInbound({
      recipient: `hello@${domain}`,
      from: `D <${sender}>`,
      messageId,
      headers: [['X-Test-Fail', 'persist']]
    })
    expect(failed.status).toBe(503)

    // Redelivery (same Message-Id, no injected failure) re-inserts the claim
    // and reuses the already-committed conversation shell.
    const retry = await postInbound({ recipient: `hello@${domain}`, from: `D <${sender}>`, messageId })
    expect(retry.status).toBe(200)
    expect(retry.body.status).toBe('contact')

    const conversations = await sql`
      SELECT c.id FROM inbox_conversations c
      JOIN crm_channels ch ON ch.id = c.channel_id
      WHERE ch.value = ${sender}
    `
    expect(conversations.length).toBe(1)
    const messages = await sql`
      SELECT m.id FROM inbox_messages m WHERE m.conversation_id = ${conversations[0]!.id as string}
    `
    expect(messages.length).toBe(1)
  })

  it('commits the conversation-origin activity row with the shell, before artifact persistence', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('shell')

    // Persistence fails and never retries — the leftover shell must still
    // explain where it came from.
    const failed = await postInbound({
      recipient: `hello@${domain}`,
      from: `S <${sender}>`,
      headers: [['X-Test-Fail', 'persist']]
    })
    expect(failed.status).toBe(503)

    const [shell] = await sql`
      SELECT c.id FROM inbox_conversations c
      JOIN crm_channels ch ON ch.id = c.channel_id
      WHERE ch.value = ${sender}
    `
    expect(shell).toBeTruthy()
    const origin = await sql`
      SELECT id FROM activity_logs
      WHERE event_type = 'inbox_conversation_created' AND record_id = ${shell!.id as string}
    `
    expect(origin.length).toBe(1)
  })

  it('drops mail without a sender address', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const res = await postInbound({ recipient: `hello@${domain}`, from: 'undisclosed-recipients:;' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ignored')
    expect(res.kernel.recipients).toEqual([expect.objectContaining({ outcome: 'drop', handler: 'inbox' })])
  })
})
