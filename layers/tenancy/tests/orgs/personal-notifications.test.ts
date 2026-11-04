// Personal-app notifications: written from a transaction with only
// `app.current_user` set, they have no org and reach their recipient's bell in
// every org.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  getAppUserDb,
  cleanupTenancyTestData,
  createOrgWithAdmin,
  createTenancyUser,
  addTestMembership,
  getAuthHeaders,
  withOrgHeader
} from '../helpers'

interface Feed { notifications: { id: string }[] }

describe('Personal-app notifications', () => {
  const sql = getHostAdminDb()
  const app = getAppUserDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })

  // Writes as a personal app does: only `app.current_user` is set.
  async function notifyFromPersonalApp(actorId: string, recipientId: string, email = 'none'): Promise<void> {
    await app.begin(async (tx) => {
      await tx`select set_config('app.current_user', ${actorId}, true)`
      await tx`
        insert into notifications (user_id, app_id, title, link, email_mode)
        values (${recipientId}, 'test-personal', 'Shared with you', '/test-personal/1', ${email})
      `
    })
  }

  it('reaches the recipient in every org they belong to', async () => {
    const a = await createOrgWithAdmin(sql)
    const b = await createOrgWithAdmin(sql)
    await addTestMembership(sql, { user_id: a.user.id, org_id: b.org.id })
    const actor = await createTenancyUser(sql)

    await notifyFromPersonalApp(actor.id, a.user.id)
    const [row] = await sql<{ id: string, org_id: string | null }[]>`
      select id, org_id from notifications where user_id = ${a.user.id} and app_id = 'test-personal'
    `
    expect(row!.org_id).toBeNull()

    for (const slug of [a.org.slug, b.org.slug]) {
      const feed = await $fetch<Feed>('/api/notifications', withOrgHeader(a.auth, slug))
      expect(feed.notifications.map(n => n.id)).toContain(row!.id)
      const counts = await $fetch<{ byApp: Record<string, number> }>('/api/notifications/unread-counts', withOrgHeader(a.auth, slug))
      expect(counts.byApp['test-personal']).toBe(1)
    }

    const read = await $fetch<{ updated: number }>('/api/notifications/read', {
      method: 'POST',
      body: { ids: [row!.id] },
      ...withOrgHeader(a.auth, b.org.slug)
    })
    expect(read.updated).toBe(1)
  })

  it('is hidden from everyone else', async () => {
    const a = await createOrgWithAdmin(sql)
    const other = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: other.id, org_id: a.org.id })

    await notifyFromPersonalApp(other.id, a.user.id)

    const feed = await $fetch<Feed>('/api/notifications', withOrgHeader(getAuthHeaders(other), a.org.slug))
    expect(feed.notifications).toEqual([])

    const orgOnly = await app.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${a.org.id}, true)`
      return await tx`select id from notifications where user_id = ${a.user.id}`
    })
    expect(orgOnly).toHaveLength(0)
  })

  it('lists recipients with pending email for the sweeps', async () => {
    const a = await createOrgWithAdmin(sql)
    const actor = await createTenancyUser(sql)

    await notifyFromPersonalApp(actor.id, a.user.id, 'immediate')

    const immediate = await app<{ user_id: string }[]>`
      select user_id from personal_notification_recipients('immediate', null) as user_id
    `
    expect(immediate.map(r => r.user_id)).toContain(a.user.id)
    const digest = await app<{ user_id: string }[]>`
      select user_id from personal_notification_recipients('digest', null) as user_id
    `
    expect(digest.map(r => r.user_id)).not.toContain(a.user.id)
  })
})
