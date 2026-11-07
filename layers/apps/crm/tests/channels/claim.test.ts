// claimChannel through POST /api/crm/records/:type/:id/channels —
// normalization, shared-identity dedupe, idempotent linking, and per-org
// uniqueness of the identity rows.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  withOrgHeader
} from '../helpers'

interface ChannelEntry {
  linkId: string
  channelId: string
  channelType: string
  value: string
  isPrimary: boolean
}

interface ChannelsResponse {
  fieldKey: string
  entries: ChannelEntry[]
}

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

async function createContact(opts: Opts, name: string): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields: { name } },
    ...opts
  })
}

async function addChannel(
  opts: Opts,
  recordId: string,
  value: string,
  channelTypeKey = 'email',
  fieldKey = 'contact_email'
): Promise<ChannelsResponse> {
  return await $fetch<ChannelsResponse>(`/api/crm/records/contacts/${recordId}/channels`, {
    method: 'POST',
    body: { channelTypeKey, fieldKey, value },
    ...opts
  })
}

describe('claim + link', () => {
  it('normalizes on claim and keeps the raw value on the identity row', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, 'test-crm Claimer')

    const res = await addChannel(opts, rec.id, 'Jane Doe <JANE.Q@Example.com>')
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]!.value).toBe('Jane Doe <JANE.Q@Example.com>')

    const rows = await sql`
      SELECT value, normalized_value FROM crm_channels WHERE id = ${res.entries[0]!.channelId}
    `
    expect(rows[0]!.normalized_value).toBe('jane.q@example.com')
  })

  it('two records claiming the same address share one identity row', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const a = await createContact(opts, 'test-crm Tom')
    const b = await createContact(opts, 'test-crm Sarah')

    const first = await addChannel(opts, a.id, 'family@example.com')
    // A different surface form of the same identity.
    const second = await addChannel(opts, b.id, '  FAMILY@example.COM ')

    expect(second.entries[0]!.channelId).toBe(first.entries[0]!.channelId)
    const rows = await sql`
      SELECT id FROM crm_channels
      WHERE org_id = ${org.id} AND channel_type = 'email' AND normalized_value = 'family@example.com'
    `
    expect(rows).toHaveLength(1)
  })

  it('re-linking the same address to the same field is a no-op', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, 'test-crm Idem')

    await addChannel(opts, rec.id, 'idem@example.com')
    const res = await addChannel(opts, rec.id, 'idem@example.com')
    expect(res.entries).toHaveLength(1)
  })

  it('400s on values the channel type rejects', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, 'test-crm BadPhone')

    const badPhone = await addChannel(opts, rec.id, '12345', 'phone', 'contact_phone').catch(e => e)
    expect(badPhone.statusCode).toBe(400)

    const badEmail = await addChannel(opts, rec.id, 'not-an-email').catch(e => e)
    expect(badEmail.statusCode).toBe(400)
  })

  it('400s when the field does not carry the given channel type', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, 'test-crm Mismatch')
    const err = await addChannel(opts, rec.id, '+15550101234', 'phone', 'contact_email').catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('scopes identity uniqueness per org — two orgs can hold the same address', async () => {
    const one = await createCrmOrgWith(sql, ['admin'])
    const two = await createCrmOrgWith(sql, ['admin'])
    const recOne = await createContact(withOrgHeader(one.auth, one.org.slug), 'test-crm OrgOne')
    const recTwo = await createContact(withOrgHeader(two.auth, two.org.slug), 'test-crm OrgTwo')

    const a = await addChannel(withOrgHeader(one.auth, one.org.slug), recOne.id, 'both@example.com')
    const b = await addChannel(withOrgHeader(two.auth, two.org.slug), recTwo.id, 'both@example.com')

    expect(a.entries[0]!.channelId).not.toBe(b.entries[0]!.channelId)
    const rows = await sql`
      SELECT org_id FROM crm_channels WHERE channel_type = 'email' AND normalized_value = 'both@example.com'
    `
    expect(rows).toHaveLength(2)
  })
})
