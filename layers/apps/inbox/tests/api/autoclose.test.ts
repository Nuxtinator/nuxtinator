// Auto-close sweep: pending conversations quiet past the org's threshold are
// closed with a system activity entry; held (needs-review) and fresh pending
// ones survive; the per-org threshold applies, and 0 disables the sweep.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, cleanupInboxTestData, createInboxOrgWith, setInboxOrgSetting, postInbound } from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

// A pending conversation whose last message is `ageDays` old.
async function pendingConversation(
  domain: string,
  opts: object,
  tag: string,
  ageDays: number,
  needsReview = false
): Promise<string> {
  const res = await postInbound({ recipient: `hello@${domain}`, from: `A <${uniqueSender(tag)}>` })
  const id = res.body.conversation_id as string
  await $fetch(`/api/inbox/conversations/${id}`, { method: 'PATCH', body: { status: 'pending', needsReview }, ...opts })
  await sql`UPDATE inbox_conversations SET last_message_at = now() - (${ageDays} * interval '1 day') WHERE id = ${id}`
  return id
}

async function statusOf(id: string): Promise<string> {
  const [row] = await sql`SELECT status FROM inbox_conversations WHERE id = ${id}`
  return row!.status as string
}

describe('auto-close sweep', () => {
  it('closes quiet pending conversations past the threshold and logs a system close', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const stale = await pendingConversation(domain, opts, 'stale', 20)
    const fresh = await pendingConversation(domain, opts, 'fresh', 3)
    const held = await pendingConversation(domain, opts, 'held', 20, true)

    const res = await $fetch<{ closed: number }>('/api/_test/inbox-autoclose', { method: 'POST' })
    expect(res.closed).toBeGreaterThanOrEqual(1)

    expect(await statusOf(stale)).toBe('closed')
    expect(await statusOf(fresh)).toBe('pending')
    expect(await statusOf(held)).toBe('pending')

    const trail = await $fetch<{ items: Array<{ eventType: string, message: string | null }> }>(
      `/api/inbox/conversations/${stale}/activity`, opts
    )
    expect(trail.items[0]!.eventType).toBe('inbox_status_changed')
    expect(trail.items[0]!.message).toContain('auto')
  })

  it('applies each org\'s own threshold, and 0 disables the sweep for that org', async () => {
    const short = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, short.org.id, 'auto_close_days', 2)
    const off = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, off.org.id, 'auto_close_days', 0)

    const shortStale = await pendingConversation(short.domain, short.opts, 'short', 3)
    const offStale = await pendingConversation(off.domain, off.opts, 'off', 400)

    await $fetch('/api/_test/inbox-autoclose', { method: 'POST' })

    expect(await statusOf(shortStale)).toBe('closed')
    expect(await statusOf(offStale)).toBe('pending')
  })
})
