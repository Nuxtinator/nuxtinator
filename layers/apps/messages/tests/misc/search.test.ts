// GET /api/messages/search
// Postgres FTS over body_md on items + comments, RLS-scoped to the active org.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupMessagesTestData,
  createMessagesOrgWith,
  createTestChannel,
  createTestDm,
  addMessagesMember,
  createTestItem,
  createTestComment,
  withOrgHeader
} from '../helpers'

describe('GET /api/messages/search', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupMessagesTestData(sql)
  })

  it('returns empty payload for empty q', async () => {
    const { org, auth } = await createMessagesOrgWith(sql, ['admin'])
    const res = await $fetch<{ items: unknown[], comments: unknown[] }>(
      '/api/messages/search?q=',
      withOrgHeader(auth, org.slug)
    )
    expect(res.items).toEqual([])
    expect(res.comments).toEqual([])
  })

  it('finds items by body_md and returns highlight ts_headline', async () => {
    const { org, user, auth } = await createMessagesOrgWith(sql, ['admin'])
    const ch = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
    const it = await createTestItem(sql, { org_id: org.id, conversation_id: ch.id, author_id: user.id, body_md: 'banana smoothie recipe' })

    const res = await $fetch<{ items: Array<{ id: string, excerpt: string }> }>(
      '/api/messages/search?q=banana',
      withOrgHeader(auth, org.slug)
    )
    const hit = res.items.find(r => r.id === it.id)
    expect(hit).toBeDefined()
    // ts_headline wraps the match in <b>…</b>
    expect(hit!.excerpt.toLowerCase()).toContain('banana')
    expect(hit!.excerpt).toContain('<b>')
  })

  it('escapes HTML in body before ts_headline (no script-tag injection)', async () => {
    const { org, user, auth } = await createMessagesOrgWith(sql, ['admin'])
    const ch = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
    await createTestItem(sql, {
      org_id: org.id,
      conversation_id: ch.id,
      author_id: user.id,
      body_md: '<script>alert(1)</script> banana payload'
    })

    const res = await $fetch<{ items: Array<{ excerpt: string }> }>(
      '/api/messages/search?q=banana',
      withOrgHeader(auth, org.slug)
    )
    expect(res.items.length).toBeGreaterThan(0)
    expect(res.items[0]!.excerpt).not.toContain('<script>')
    expect(res.items[0]!.excerpt).toContain('&lt;script&gt;')
  })

  it('finds comments separately from items', async () => {
    const { org, user, auth } = await createMessagesOrgWith(sql, ['admin'])
    const ch = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
    const it = await createTestItem(sql, { org_id: org.id, conversation_id: ch.id, author_id: user.id, body_md: 'nothing here' })
    const c = await createTestComment(sql, { org_id: org.id, item_id: it.id, author_id: user.id, body_md: 'banana split' })

    const res = await $fetch<{ items: Array<{ id: string }>, comments: Array<{ id: string }> }>(
      '/api/messages/search?q=banana',
      withOrgHeader(auth, org.slug)
    )
    expect(res.comments.map(r => r.id)).toContain(c.id)
    expect(res.items.map(r => r.id)).not.toContain(it.id)
  })

  it('returns DM items and comments only to the DM participants', async () => {
    const { org, auth } = await createMessagesOrgWith(sql, ['admin'])
    const a = await addMessagesMember(sql, org.id)
    const b = await addMessagesMember(sql, org.id)
    const outsider = await addMessagesMember(sql, org.id)
    const dm = await createTestDm(sql, { org_id: org.id, created_by: a.user.id, other_user_id: b.user.id })
    const it = await createTestItem(sql, { org_id: org.id, conversation_id: dm.id, author_id: a.user.id, body_md: 'banana salary' })
    const c = await createTestComment(sql, { org_id: org.id, item_id: it.id, author_id: b.user.id, body_md: 'banana reply' })

    type Res = { items: Array<{ id: string }>, comments: Array<{ id: string }> }
    const asParticipant = await $fetch<Res>('/api/messages/search?q=banana', withOrgHeader(b.auth, org.slug))
    expect(asParticipant.items.map(r => r.id)).toContain(it.id)
    expect(asParticipant.comments.map(r => r.id)).toContain(c.id)

    // Neither a plain member nor an org admin outside the DM sees it.
    for (const caller of [outsider.auth, auth]) {
      const res = await $fetch<Res>('/api/messages/search?q=banana', withOrgHeader(caller, org.slug))
      expect(res.items).toEqual([])
      expect(res.comments).toEqual([])
    }
  })

  it('does not surface results from other orgs (RLS)', async () => {
    const a = await createMessagesOrgWith(sql, ['admin'])
    const b = await createMessagesOrgWith(sql, ['admin'])
    const chA = await createTestChannel(sql, { org_id: a.org.id, created_by: a.user.id })
    const chB = await createTestChannel(sql, { org_id: b.org.id, created_by: b.user.id })
    await createTestItem(sql, { org_id: a.org.id, conversation_id: chA.id, author_id: a.user.id, body_md: 'banana in orgA' })
    await createTestItem(sql, { org_id: b.org.id, conversation_id: chB.id, author_id: b.user.id, body_md: 'banana in orgB' })

    // a's user calls search against orgA — must not see orgB's banana.
    const res = await $fetch<{ items: Array<{ excerpt: string }> }>(
      '/api/messages/search?q=banana',
      withOrgHeader(a.auth, a.org.slug)
    )
    expect(res.items.length).toBe(1)
    expect(res.items[0]!.excerpt.toLowerCase()).toContain('orga')
  })
})
