// Per-org inbox settings surface: an org admin reads and writes the
// configuration through /api/inbox/settings, values persist as org-scoped
// overrides, and a freshly set contact-form API key immediately routes
// public submissions to the org. Non-admins are refused. Only an operator
// admin changes the inbound domain and contact address.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, cleanupInboxTestData, createInboxOrgWith } from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

interface Settings {
  inboundDomain: string
  contactAddress: string
  autoAckEnabled: boolean
  contactFormApiKey: string
  groundingSourceUrls: string[]
  notifyUserIds: string[]
}

describe('inbox settings admin', () => {
  it('org admin reads + writes settings; a new API key routes the contact form to the org', async () => {
    const { org, user, opts, domain } = await createInboxOrgWith(sql)
    await sql`UPDATE users SET is_admin = true WHERE id = ${user.id}`

    const current = await $fetch<Settings>('/api/inbox/settings', opts)
    expect(current.inboundDomain).toBe(domain)
    expect(current.autoAckEnabled).toBe(true)

    const newDomain = `mail.${org.slug}.test`
    const apiKey = `test-inbox-key-${randomUUID()}`
    const updated = await $fetch<Settings>('/api/inbox/settings', {
      method: 'PUT',
      body: {
        inboundDomain: newDomain,
        contactAddress: `contact@${newDomain}`,
        autoAckEnabled: false,
        contactFormApiKey: apiKey,
        groundingSourceUrls: ['https://example.com/help', 'not-a-url', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5:5432/']
      },
      ...opts
    })
    expect(updated.inboundDomain).toBe(newDomain)
    expect(updated.contactAddress).toBe(`contact@${newDomain}`)
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

  it('only an operator changes the domain and address; the domain is unique and the address lives on it', async () => {
    const a = await createInboxOrgWith(sql)
    const b = await createInboxOrgWith(sql)
    const put = (opts: typeof a.opts, body: Record<string, unknown>) =>
      $fetch<Settings & { mailIdentityEditable: boolean }>('/api/inbox/settings', { method: 'PUT', body, ...opts })

    // An org admin can't move the domain or address, but saving them unchanged is fine.
    expect((await $fetch<{ mailIdentityEditable: boolean }>('/api/inbox/settings', b.opts)).mailIdentityEditable).toBe(false)
    await expect(put(b.opts, { inboundDomain: a.domain })).rejects.toMatchObject({ statusCode: 403 })
    await expect(put(b.opts, { contactAddress: `support@${a.domain}` })).rejects.toMatchObject({ statusCode: 403 })
    const unchanged = await put(b.opts, { inboundDomain: b.domain, contactAddress: `contact@${b.domain}`, autoAckEnabled: false })
    expect(unchanged.autoAckEnabled).toBe(false)

    await sql`UPDATE users SET is_admin = true WHERE id = ${b.user.id}`
    await expect(put(b.opts, { inboundDomain: a.domain, contactAddress: `contact@${a.domain}` })).rejects.toMatchObject({ statusCode: 409 })
    await expect(put(b.opts, { contactAddress: `support@${a.domain}` })).rejects.toMatchObject({ statusCode: 400 })
    const moved = await put(b.opts, { inboundDomain: `new.${b.domain}`, contactAddress: `help@new.${b.domain}` })
    expect(moved).toMatchObject({ inboundDomain: `new.${b.domain}`, contactAddress: `help@new.${b.domain}`, mailIdentityEditable: true })
  })

  it('refuses non-admins (403) and malformed values (400)', async () => {
    const agent = await createInboxOrgWith(sql, ['inbox_agent'])
    await expect($fetch('/api/inbox/settings', agent.opts)).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      $fetch('/api/inbox/settings', { method: 'PUT', body: { autoAckEnabled: false }, ...agent.opts })
    ).rejects.toMatchObject({ statusCode: 403 })

    const admin = await createInboxOrgWith(sql)
    await expect(
      $fetch('/api/inbox/settings', { method: 'PUT', body: { inboundDomain: 'not a domain!' }, ...admin.opts })
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      $fetch('/api/inbox/settings', { method: 'PUT', body: { contactAddress: 'not-an-email' }, ...admin.opts })
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      $fetch('/api/inbox/settings', { method: 'PUT', body: { notifyUserIds: ['not-a-user-id'] }, ...admin.opts })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
