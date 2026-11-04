// Bulk triage: status / assignee / add-tag actions over a set of
// conversations, each logged per conversation; closing clears review flags;
// spam rows are skipped by status changes; input validation; org isolation.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, cleanupInboxTestData, createInboxOrgWith, createInboxUser, postInbound } from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

async function conversation(domain: string, tag: string): Promise<string> {
  const res = await postInbound({ recipient: `hello@${domain}`, from: `A <${uniqueSender(tag)}>` })
  return res.body.conversation_id as string
}

async function row(id: string): Promise<{ status: string, needs_review: boolean, assigned_user_id: string | null, tags: string[] }> {
  const [r] = await sql`SELECT status, needs_review, assigned_user_id, tags FROM inbox_conversations WHERE id = ${id}`
  return r as never
}

async function bulk(opts: object, body: Record<string, unknown>): Promise<number> {
  const res = await $fetch<{ updated: number }>('/api/inbox/conversations/bulk', { method: 'POST', body, ...opts })
  return res.updated
}

describe('bulk triage API', () => {
  it('closes a set (clearing review flags), assigns, and adds tags — logging each conversation', async () => {
    const { opts, user, domain } = await createInboxOrgWith(sql)
    const a = await conversation(domain, 'a')
    const b = await conversation(domain, 'b')
    const c = await conversation(domain, 'c')
    await $fetch(`/api/inbox/conversations/${a}`, { method: 'PATCH', body: { needsReview: true }, ...opts })

    expect(await bulk(opts, { ids: [a, b], status: 'closed' })).toBe(2)
    expect((await row(a)).status).toBe('closed')
    expect((await row(a)).needs_review).toBe(false)
    expect((await row(b)).status).toBe('closed')
    expect((await row(c)).status).toBe('open')

    expect(await bulk(opts, { ids: [a, b, c], assignedUserId: user.id })).toBe(3)
    expect((await row(c)).assigned_user_id).toBe(user.id)

    const { tag } = await $fetch<{ tag: { slug: string } }>('/api/inbox/tags', { method: 'POST', body: { name: 'Billing' }, ...opts })
    expect(await bulk(opts, { ids: [a, b], addTags: [tag.slug, 'not-a-tag'] })).toBe(2)
    expect((await row(a)).tags).toEqual([tag.slug])
    // Rows already carrying the tag are untouched — nothing to report.
    expect(await bulk(opts, { ids: [a, b], addTags: [tag.slug] })).toBe(0)

    const trail = await $fetch<{ items: Array<{ eventType: string, message: string | null }> }>(
      `/api/inbox/conversations/${a}/activity`, opts
    )
    const types = trail.items.map(i => i.eventType)
    expect(types).toContain('inbox_status_changed')
    expect(types).toContain('inbox_assigned')
    expect(types).toContain('inbox_tags_updated')
    expect(trail.items.find(i => i.eventType === 'inbox_status_changed')!.message).toBe('Status → closed')
  })

  it('skips spam rows on status changes and rejects bad input', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    const spam = await conversation(domain, 'spam')
    const plain = await conversation(domain, 'plain')
    await $fetch(`/api/inbox/conversations/${spam}`, { method: 'PATCH', body: { status: 'spam' }, ...opts })

    // Only the non-spam row moves; the spam verdict stays a per-thread call.
    expect(await bulk(opts, { ids: [spam, plain], status: 'pending' })).toBe(1)
    expect((await row(spam)).status).toBe('spam')
    expect((await row(plain)).status).toBe('pending')
    // A no-op status (already pending) counts nothing.
    expect(await bulk(opts, { ids: [plain], status: 'pending' })).toBe(0)

    await expect(bulk(opts, { ids: [plain] })).rejects.toMatchObject({ statusCode: 400 })
    await expect(bulk(opts, { ids: [plain], status: 'spam' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(bulk(opts, { ids: Array.from({ length: 101 }, () => randomUUID()), status: 'open' }))
      .rejects.toMatchObject({ statusCode: 400 })

    // An assignee who can't open the inbox is refused, as on the single endpoint.
    const outsider = await createInboxUser(sql)
    await expect(bulk(opts, { ids: [plain], assignedUserId: outsider.id })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('never touches another org\'s conversations', async () => {
    const a = await createInboxOrgWith(sql)
    const b = await createInboxOrgWith(sql)
    const theirs = await conversation(a.domain, 'theirs')

    expect(await bulk(b.opts, { ids: [theirs], status: 'closed', assignedUserId: null })).toBe(0)
    expect((await row(theirs)).status).toBe('open')
  })
})
