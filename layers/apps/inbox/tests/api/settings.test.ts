// Per-org inbox settings surface: an org admin reads and writes the
// configuration through /api/inbox/settings, values persist as org-scoped
// overrides, and a freshly set contact-form API key immediately routes
// public submissions to the org. Callers without inbox.settings.manage are
// refused. The mail domain and contact address are derived, never written.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, cleanupInboxTestData, createInboxOrgWith } from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

interface Settings {
  mailDomain: string
  contactLocal: string
  contactAddress: string
  autoAckEnabled: boolean
  contactFormApiKey: string
  groundingSourceUrls: string[]
  notifyUserIds: string[]
}

describe('inbox settings admin', () => {
  it('org admin reads + writes settings; a new API key routes the contact form to the org', async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)

    const current = await $fetch<Settings>('/api/inbox/settings', opts)
    expect(current.mailDomain).toBe(domain)
    expect(current.autoAckEnabled).toBe(true)

    const apiKey = `test-inbox-key-${randomUUID()}`
    const updated = await $fetch<Settings>('/api/inbox/settings', {
      method: 'PUT',
      body: {
        contactLocal: 'help',
        autoAckEnabled: false,
        contactFormApiKey: apiKey,
        groundingSourceUrls: ['https://example.com/help', 'not-a-url', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5:5432/']
      },
      ...opts
    })
    expect(updated.contactAddress).toBe(`help@${domain}`)
    expect(updated.autoAckEnabled).toBe(false)
    expect(updated.contactFormApiKey).toBe(apiKey)
    // The registered parse sanitizes on write — non-http and private-address entries drop.
    expect(updated.groundingSourceUrls).toEqual(['https://example.com/help'])

    // Onboarding loop closes: the key set through the API gates and routes
    // the public contact form to this org.
    const res = await $fetch<{ status: string, conversationId: string }>('/api/inbox/contact', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { email: 'visitor@example.com', message: 'Hi via the new key' }
    })
    expect(res.status).toBe('received')
    const [row] = await sql`SELECT org_id FROM inbox_conversations WHERE id = ${res.conversationId}`
    expect(row!.org_id).toBe(org.id)
  })

  it('round-trips the unassigned-mail email recipients, defaulting to empty', async () => {
    const { user, opts } = await createInboxOrgWith(sql)

    const current = await $fetch<Settings>('/api/inbox/settings', opts)
    expect(current.notifyUserIds).toEqual([])

    const updated = await $fetch<Settings>('/api/inbox/settings', {
      method: 'PUT',
      body: { notifyUserIds: [user.id, user.id] },
      ...opts
    })
    // The registered parse dedupes on write.
    expect(updated.notifyUserIds).toEqual([user.id])

    const cleared = await $fetch<Settings>('/api/inbox/settings', {
      method: 'PUT',
      body: { notifyUserIds: [] },
      ...opts
    })
    expect(cleared.notifyUserIds).toEqual([])
  })

  it('refuses the old domain and address fields', async () => {
    const { opts, domain } = await createInboxOrgWith(sql)
    for (const body of [{ inboundDomain: domain }, { contactAddress: `support@${domain}` }]) {
      await expect($fetch('/api/inbox/settings', { method: 'PUT', body, ...opts })).rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it('refuses callers without inbox.settings.manage (403), admits a granted agent, and rejects malformed values (400)', async () => {
    const agent = await createInboxOrgWith(sql, ['inbox_agent'])
    await expect($fetch('/api/inbox/settings', agent.opts)).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      $fetch('/api/inbox/settings', { method: 'PUT', body: { autoAckEnabled: false }, ...agent.opts })
    ).rejects.toMatchObject({ statusCode: 403 })

    await sql`
      INSERT INTO user_permission_grants (user_id, permission, org_id)
      VALUES (${agent.user.id}, 'inbox.settings.manage', ${agent.org.id})
    `
    const granted = await $fetch<Settings>('/api/inbox/settings', agent.opts)
    expect(granted.mailDomain).toBe(agent.domain)

    const admin = await createInboxOrgWith(sql)
    await expect(
      $fetch('/api/inbox/settings', { method: 'PUT', body: { contactLocal: 'not a local part!' }, ...admin.opts })
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      $fetch('/api/inbox/settings', { method: 'PUT', body: { notifyUserIds: ['not-a-user-id'] }, ...admin.opts })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
