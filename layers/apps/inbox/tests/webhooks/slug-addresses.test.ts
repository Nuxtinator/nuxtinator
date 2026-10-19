// Slug addresses (INBOX_SLUG_ADDRESSES, on for the inbox test boot): an org on
// the shared INBOX_DOMAIN receives new mail at <slug>@<shared domain>, derived
// on every read and never stored. Covers routing, unknown/reserved slugs,
// slug renames, settings saves, the shared-domain rules and personal aliases.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  postInbound,
  withOrgHeader,
  INBOX_TEST_SHARED_DOMAIN as SHARED
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

interface Settings {
  inboundDomain: string
  contactAddress: string
  autoAckEnabled: boolean
}

function sender() {
  return `test-inbox-jane-${randomUUID().slice(0, 8)}@sender.example`
}

// An inbox org with no inbound-domain or contact overrides, so it sits on the
// shared domain.
async function createSharedOrg(roles: string[] = ['admin']) {
  const o = await createInboxOrgWith(sql, roles)
  await sql`DELETE FROM core_settings WHERE org_id = ${o.org.id} AND namespace = 'inbox'`
  return o
}

async function storedIdentityKeys(orgId: string): Promise<string[]> {
  const rows = await sql<{ key: string }[]>`
    SELECT key FROM core_settings
    WHERE org_id = ${orgId} AND namespace = 'inbox' AND key IN ('inbound_domain', 'contact_address')
  `
  return rows.map(r => r.key)
}

async function conversationOrg(id: unknown): Promise<string | undefined> {
  const [row] = await sql<{ org_id: string }[]>`SELECT org_id FROM inbox_conversations WHERE id = ${id as string}`
  return row?.org_id
}

describe('slug addresses', () => {
  it('derives the contact address from the slug and routes mail to it', async () => {
    const { org, opts } = await createSharedOrg()
    const settings = await $fetch<Settings>('/api/inbox/settings', opts)
    expect(settings).toMatchObject({ inboundDomain: SHARED, contactAddress: `${org.slug}@${SHARED}` })

    const res = await postInbound({ recipient: `${org.slug}@${SHARED}`, from: `Jane <${sender()}>` })
    expect(res.body.status).toBe('contact')
    expect(await conversationOrg(res.body.conversation_id)).toBe(org.id)
  })

  it('drops mail to an unknown slug, a reserved local part, or an org without the inbox', async () => {
    const { org } = await createSharedOrg()
    for (const local of [`test-inbox-nobody-${randomUUID().slice(0, 6)}`, 'contact', 'postmaster']) {
      const res = await postInbound({ recipient: `${local}@${SHARED}`, from: `Jane <${sender()}>` })
      expect(res.body).toMatchObject({ status: 'ignored', reason: 'unroutable' })
    }

    await sql`UPDATE org_apps SET enabled = false WHERE org_id = ${org.id} AND app_id = 'inbox'`
    const res = await postInbound({ recipient: `${org.slug}@${SHARED}`, from: `Jane <${sender()}>` })
    expect(res.body).toMatchObject({ status: 'ignored', reason: 'unroutable' })
  })

  it('follows a slug rename: the new address routes, the old one no longer does', async () => {
    const { org, auth } = await createSharedOrg()
    const renamed = `test-inbox-${randomUUID().slice(0, 8)}`
    await sql`UPDATE orgs SET slug = ${renamed} WHERE id = ${org.id}`

    const settings = await $fetch<Settings>('/api/inbox/settings', withOrgHeader(auth, renamed))
    expect(settings.contactAddress).toBe(`${renamed}@${SHARED}`)

    const fresh = await postInbound({ recipient: `${renamed}@${SHARED}`, from: `Jane <${sender()}>` })
    expect(await conversationOrg(fresh.body.conversation_id)).toBe(org.id)
    const stale = await postInbound({ recipient: `${org.slug}@${SHARED}`, from: `Jane <${sender()}>` })
    expect(stale.body).toMatchObject({ status: 'ignored', reason: 'unroutable' })
  })

  it('saving unchanged settings stores no inbound domain or contact address', async () => {
    const { org, user, opts } = await createSharedOrg()
    await sql`UPDATE users SET is_admin = true WHERE id = ${user.id}`
    const current = await $fetch<Settings>('/api/inbox/settings', opts)
    const saved = await $fetch<Settings>('/api/inbox/settings', {
      method: 'PUT',
      body: { inboundDomain: current.inboundDomain, contactAddress: current.contactAddress, autoAckEnabled: false },
      ...opts
    })
    expect(saved).toMatchObject({ contactAddress: `${org.slug}@${SHARED}`, autoAckEnabled: false })
    expect(await storedIdentityKeys(org.id)).toEqual([])
  })

  it('keeps the shared domain for derived addresses: no custom address there, never claimed by an org', async () => {
    const { org, user, opts } = await createInboxOrgWith(sql)
    await createSharedOrg()
    await sql`UPDATE users SET is_admin = true WHERE id = ${user.id}`

    await expect($fetch('/api/inbox/settings', {
      method: 'PUT', body: { inboundDomain: SHARED, contactAddress: `support@${SHARED}` }, ...opts
    })).rejects.toMatchObject({ statusCode: 400 })

    const moved = await $fetch<Settings>('/api/inbox/settings', {
      method: 'PUT', body: { inboundDomain: SHARED, contactAddress: `${org.slug}@${SHARED}` }, ...opts
    })
    expect(moved).toMatchObject({ inboundDomain: SHARED, contactAddress: `${org.slug}@${SHARED}` })
    expect(await storedIdentityKeys(org.id)).toEqual([])
  })

  it('gives personal aliases no From address on the shared domain', async () => {
    const { user, opts } = await createSharedOrg()
    await $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { alias: 'jane' }, ...opts })
    const me = await $fetch<{ alias: string, personalFrom: string | null }>('/api/inbox/me', opts)
    expect(me.alias).toBe('jane')
    expect(me.personalFrom).toBeNull()
  })
})
