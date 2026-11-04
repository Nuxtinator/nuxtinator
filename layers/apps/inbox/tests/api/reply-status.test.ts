// Reply deliverability on the detail payload: the address a reply goes to,
// whether ownership is proven, and any active suppression — resolved by the
// same util the send sweep uses.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, cleanupInboxTestData, createInboxOrgWith, postInbound, postDeliveryEvent } from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

interface ReplyStatus {
  email: string | null
  verified: boolean
  suppression: { reason: string, detail: string | null, since: string } | null
}

async function replyStatus(id: string, opts: object): Promise<ReplyStatus> {
  const detail = await $fetch<{ replyStatus: ReplyStatus }>(`/api/inbox/conversations/${id}`, opts)
  return detail.replyStatus
}

describe('reply status', () => {
  it('reports a verified, mailable target for an authenticated sender', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('verified')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `V <${sender}>` })

    const status = await replyStatus(res.body.conversation_id as string, opts)
    expect(status.email).toBe(sender)
    expect(status.verified).toBe(true)
    expect(status.suppression).toBeNull()
  })

  it('reports an unverified target for an unauthenticated sender', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('unverified')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `U <${sender}>`, authenticated: false })

    const status = await replyStatus(res.body.conversation_id as string, opts)
    expect(status.email).toBe(sender)
    expect(status.verified).toBe(false)
  })

  it('surfaces the active suppression after a hard bounce', async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('bounced')
    const res = await postInbound({ recipient: `hello@${domain}`, from: `B <${sender}>` })
    await postDeliveryEvent({
      event: 'failed', severity: 'permanent', recipient: sender,
      'delivery-status': { message: '550 mailbox gone' },
      'user-variables': { 'inbox-org': org.id }
    })

    const status = await replyStatus(res.body.conversation_id as string, opts)
    expect(status.suppression?.reason).toBe('hard_bounce')
    expect(status.suppression?.detail).toContain('550')
    expect(status.suppression?.since).toBeTruthy()
  })
})
