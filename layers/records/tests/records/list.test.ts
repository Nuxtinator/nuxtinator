// The list engine through GET /api/records/entries/:type — per-storage filters,
// free-text search over names + channels, and the visibility rule (view_all
// vs shared vs assigned).
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

interface ListResponse {
  items: Array<{ id: string, name: string, status: string | null, assignedTo: string[] }>
  total: number
}

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

// Confirmed: assigning someone who can't see the contact yet shares it.
async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields, confirmShare: true },
    ...opts
  })
}

async function list(opts: Opts, query: Record<string, string>): Promise<ListResponse> {
  const qs = new URLSearchParams(query).toString()
  return await $fetch<ListResponse>(`/api/records/entries/contacts${qs ? `?${qs}` : ''}`, opts)
}

describe('filters', () => {
  it('eq and in over the promoted status column', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createContact(opts, { name: 'test-records A', status: 'active' })
    await createContact(opts, { name: 'test-records B', status: 'paused' })
    await createContact(opts, { name: 'test-records C', status: 'closed', reason_closed: 'duplicate' })

    const eq = await list(opts, { filters: JSON.stringify({ status: 'active' }) })
    expect(eq.total).toBe(1)
    expect(eq.items[0]!.name).toBe('test-records A')

    const inOp = await list(opts, { filters: JSON.stringify({ status: { in: ['active', 'paused'] } }) })
    expect(inOp.total).toBe(2)
  })

  it('gte/lte with numeric casts over a jsonb custom field', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    // An admin-created number field lives in records_entries.data.
    await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST',
      body: { fieldKey: 'score', kind: 'number', label: 'Score' },
      ...opts
    })
    await createContact(opts, { name: 'test-records Low', score: 9 })
    await createContact(opts, { name: 'test-records High', score: 50 })

    const gte = await list(opts, { filters: JSON.stringify({ score: { gte: 20 } }) })
    expect(gte.total).toBe(1)
    expect(gte.items[0]!.name).toBe('test-records High')

    // Numeric, not lexical: 9 < 20 even though '9' > '20' as text.
    const lte = await list(opts, { filters: JSON.stringify({ score: { lte: 20 } }) })
    expect(lte.total).toBe(1)
    expect(lte.items[0]!.name).toBe('test-records Low')
  })

  it('eq over an entries field (multi_select)', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createContact(opts, { name: 'test-records ES', languages: ['es'] })
    await createContact(opts, { name: 'test-records EN', languages: ['en'] })

    const res = await list(opts, { filters: JSON.stringify({ languages: 'es' }) })
    expect(res.total).toBe(1)
    expect(res.items[0]!.name).toBe('test-records ES')
  })

  it('400s on unknown filter keys', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const err = await list(opts, { filters: JSON.stringify({ bogus: 'x' }) }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })
})

describe('free-text search', () => {
  it('matches record names and linked channel values', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const jane = await createContact(opts, { name: 'test-records Jane Miller' })
    await $fetch(`/api/crm/records/contacts/${jane.id}/channels`, {
      method: 'POST',
      body: { channelTypeKey: 'email', fieldKey: 'contact_email', value: 'jane.q@example.com' },
      ...opts
    })
    await createContact(opts, { name: 'test-records Someone Else' })

    const byName = await list(opts, { q: 'Miller' })
    expect(byName.total).toBe(1)

    const byChannel = await list(opts, { q: 'jane.q@' })
    expect(byChannel.total).toBe(1)
    expect(byChannel.items[0]!.id).toBe(jane.id)
  })
})

describe('visibility', () => {
  it('members without view_all see only assigned or shared records', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const memberOpts = withOrgHeader(member.auth, org.slug)

    const assigned = await createContact(adminOpts, { name: 'test-records Assigned', assigned_to: [member.user.id] })
    const shared = await createContact(adminOpts, { name: 'test-records Shared' })
    await createContact(adminOpts, { name: 'test-records Invisible' })
    await $fetch(`/api/records/entries/contacts/${shared.id}/shares`, {
      method: 'POST',
      body: { userId: member.user.id },
      ...adminOpts
    })

    // The org admin (view_all via the admin role) sees all three.
    const adminList = await list(adminOpts, {})
    expect(adminList.total).toBe(3)

    const memberList = await list(memberOpts, {})
    expect(memberList.total).toBe(2)
    expect(memberList.items.map(i => i.id).sort()).toEqual([assigned.id, shared.id].sort())

    // The invisible record 404s on direct access too — existence is not leaked.
    const invisible = adminList.items.find(i => i.name === 'test-records Invisible')!
    const err = await $fetch(`/api/records/entries/contacts/${invisible.id}`, memberOpts).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('creators keep visibility of records they created', async () => {
    const { org } = await createRecordsOrgWith(sql, ['admin'])
    const creator = await addRecordsMember(sql, org.id, ['member'])
    const other = await addRecordsMember(sql, org.id, ['member'])
    const creatorOpts = withOrgHeader(creator.auth, org.slug)
    const otherOpts = withOrgHeader(other.auth, org.slug)

    // No assignment and no share — the created_by leg is the only one that applies.
    const mine = await createContact(creatorOpts, { name: 'test-records Mine' })

    const creatorList = await list(creatorOpts, {})
    expect(creatorList.items.map(i => i.id)).toContain(mine.id)
    const detail = await $fetch<{ id: string }>(`/api/records/entries/contacts/${mine.id}`, creatorOpts)
    expect(detail.id).toBe(mine.id)

    const otherList = await list(otherOpts, {})
    expect(otherList.items.map(i => i.id)).not.toContain(mine.id)
    const err404 = await $fetch(`/api/records/entries/contacts/${mine.id}`, otherOpts).catch(e => e)
    expect(err404.statusCode).toBe(404)
  })
})
