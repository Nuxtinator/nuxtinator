// Slug addresses (INBOX_SLUG_ADDRESSES, on for the inbox test boot): an org
// without its own receiving domain uses the host's inbox domain (the env
// domain here) and receives new mail at <slug>@<that domain>, derived on every
// read and never stored. Covers routing, unknown/reserved slugs, slug
// renames, the contact local part on an org's own domain, and personal aliases.
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
  mailDomain: string
  slugAddress: boolean
  contactLocal: string
  contactAddress: string
  autoAckEnabled: boolean
}

function sender() {
  return `test-inbox-jane-${randomUUID().slice(0, 8)}@sender.example`
}

// An inbox org without a mail domain of its own, so it sits on the host's.
async function createSharedOrg(roles: string[] = ['admin']) {
  const o = await createInboxOrgWith(sql, roles)
  await sql`DELETE FROM mail_domains WHERE org_id = ${o.org.id}`
  return o
}

async function conversationOrg(id: unknown): Promise<string | undefined> {
  const [row] = await sql<{ org_id: string }[]>`SELECT org_id FROM inbox_conversations WHERE id = ${id as string}`
  return row?.org_id
}

describe('slug addresses', () => {
  it('derives the contact address from the slug and routes mail to it', async () => {
    const { org, opts } = await createSharedOrg()
    const settings = await $fetch<Settings>('/api/inbox/settings', opts)
    expect(settings).toMatchObject({ mailDomain: SHARED, slugAddress: true, contactAddress: `${org.slug}@${SHARED}` })

    const res = await postInbound({ recipient: `${org.slug}@${SHARED}`, from: `Jane <${sender()}>` })
    expect(res.body.status).toBe('contact')
    expect(await conversationOrg(res.body.conversation_id)).toBe(org.id)
  })

  it('drops mail to an unknown slug, a reserved local part, or an org without the inbox', async () => {
    const { org } = await createSharedOrg()
    for (const local of [`test-inbox-nobody-${randomUUID().slice(0, 6)}`, 'contact', 'bounce', 'nx-anything']) {
      const res = await postInbound({ recipient: `${local}@${SHARED}`, from: `Jane <${sender()}>` })
      expect(res.body.status).toBe('ignored')
    }

    await sql`UPDATE org_apps SET enabled = false WHERE org_id = ${org.id} AND app_id = 'inbox'`
    const res = await postInbound({ recipient: `${org.slug}@${SHARED}`, from: `Jane <${sender()}>` })
    expect(res.body.status).toBe('ignored')
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
    expect(stale.body.status).toBe('ignored')
  })

  it('ignores the contact local part on the shared domain', async () => {
    const { org, opts } = await createSharedOrg()
    const saved = await $fetch<Settings>('/api/inbox/settings', {
      method: 'PUT', body: { contactLocal: 'support', autoAckEnabled: false }, ...opts
    })
    expect(saved).toMatchObject({ contactLocal: 'support', contactAddress: `${org.slug}@${SHARED}`, autoAckEnabled: false })
  })

  it('uses <contact_local>@ an org\'s own domain and routes mail to it', async () => {
    const { org, opts, domain } = await createInboxOrgWith(sql)
    expect(await $fetch<Settings>('/api/inbox/settings', opts))
      .toMatchObject({ mailDomain: domain, slugAddress: false, contactLocal: 'contact', contactAddress: `contact@${domain}` })

    const saved = await $fetch<Settings>('/api/inbox/settings', { method: 'PUT', body: { contactLocal: 'Support' }, ...opts })
    expect(saved.contactAddress).toBe(`support@${domain}`)
    const [stored] = await sql`SELECT value FROM core_settings WHERE org_id = ${org.id} AND namespace = 'inbox' AND key = 'contact_local'`
    expect(stored!.value).toBe('support')

    // Back to the default clears the override.
    await $fetch('/api/inbox/settings', { method: 'PUT', body: { contactLocal: 'contact' }, ...opts })
    const rows = await sql`SELECT 1 FROM core_settings WHERE org_id = ${org.id} AND namespace = 'inbox' AND key = 'contact_local'`
    expect(rows.length).toBe(0)

    const res = await postInbound({ recipient: `contact@${domain}`, from: `Jane <${sender()}>` })
    expect(await conversationOrg(res.body.conversation_id)).toBe(org.id)
  })

  it('refuses reserved or malformed contact local parts', async () => {
    const { opts } = await createInboxOrgWith(sql)
    for (const contactLocal of ['bounce', 'nx-probe', 'has space', '']) {
      await expect($fetch('/api/inbox/settings', { method: 'PUT', body: { contactLocal }, ...opts }))
        .rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it('gives personal aliases no From address on the shared domain', async () => {
    const { user, opts } = await createSharedOrg()
    await $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { alias: 'jane' }, ...opts })
    const me = await $fetch<{ alias: string, personalFrom: string | null }>('/api/inbox/me', opts)
    expect(me.alias).toBe('jane')
    expect(me.personalFrom).toBeNull()
  })
})
