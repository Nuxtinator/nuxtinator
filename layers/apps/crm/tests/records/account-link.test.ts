// A record linked to a user account (crm_records.user_id): its name and email
// addresses are the account's, so the record and channel routes refuse to
// change them while other fields and consent stay editable.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  createCrmUser,
  withOrgHeader
} from '../helpers'

interface ChannelsResponse {
  fieldKey: string
  entries: { linkId: string, channelId: string, value: string }[]
}

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

async function linkedContact(opts: Opts) {
  const rec = await $fetch<{ id: string }>('/api/crm/records/contacts', { method: 'POST', body: { fields: { name: 'test-crm Linked' } }, ...opts })
  const channels = await $fetch<ChannelsResponse>(`/api/crm/records/contacts/${rec.id}/channels`, {
    method: 'POST',
    body: { channelTypeKey: 'email', fieldKey: 'contact_email', value: 'test-crm-linked@example.com' },
    ...opts
  })
  const person = await createCrmUser(sql)
  await sql`UPDATE crm_records SET user_id = ${person.id} WHERE id = ${rec.id}`
  return { id: rec.id, personId: person.id, linkId: channels.entries[0]!.linkId }
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err) {
    return (err as { statusCode?: number, response?: { status?: number } }).statusCode ?? (err as { response?: { status?: number } }).response?.status ?? 0
  }
}

describe('account-linked records', () => {
  it('reports the linked account on the detail', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await linkedContact(opts)
    const detail = await $fetch<{ userId: string | null, accountOwnedChannelTypes: string[] }>(`/api/crm/records/contacts/${rec.id}`, opts)
    expect(detail.userId).toBe(rec.personId)
    expect(detail.accountOwnedChannelTypes).toEqual(['email'])
  })

  it('refuses renames and email changes', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await linkedContact(opts)
    const base = `/api/crm/records/contacts/${rec.id}`

    expect(await status($fetch(base, { method: 'PATCH', body: { fields: { name: 'test-crm Renamed' } }, ...opts }))).toBe(409)
    expect(await status($fetch(`${base}/channels`, { method: 'POST', body: { channelTypeKey: 'email', fieldKey: 'contact_email', value: 'test-crm-other@example.com' }, ...opts }))).toBe(409)
    expect(await status($fetch(`${base}/channels/${rec.linkId}`, { method: 'PATCH', body: { value: 'test-crm-other@example.com' }, ...opts }))).toBe(409)
    expect(await status($fetch(`${base}/channels/${rec.linkId}`, { method: 'DELETE', ...opts }))).toBe(409)

    const rows = await sql`SELECT name FROM crm_records WHERE id = ${rec.id}`
    expect(rows[0]!.name).toBe('test-crm Linked')
  })

  it('leaves the name as it is, primary and label editable', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await linkedContact(opts)
    const base = `/api/crm/records/contacts/${rec.id}`

    expect(await status($fetch(base, { method: 'PATCH', body: { fields: { name: 'test-crm Linked' } }, ...opts }))).toBe(200)
    expect(await status($fetch(`${base}/channels/${rec.linkId}`, { method: 'PATCH', body: { label: 'Work' }, ...opts }))).toBe(200)
    expect(await status($fetch(`${base}/channels/${rec.linkId}`, { method: 'PATCH', body: { primary: true }, ...opts }))).toBe(200)
  })

  it('keeps the same edits open once the link is gone', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await linkedContact(opts)
    await sql`UPDATE crm_records SET user_id = NULL WHERE id = ${rec.id}`
    const renamed = await $fetch<{ name: string }>(`/api/crm/records/contacts/${rec.id}`, { method: 'PATCH', body: { fields: { name: 'test-crm Renamed' } }, ...opts })
    expect(renamed.name).toBe('test-crm Renamed')
  })
})
