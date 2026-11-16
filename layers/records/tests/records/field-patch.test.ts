// applyFieldPatch through the record routes: jsonb set/null-delete, entry
// add/remove/force, user_refs, required-on-create, unknown fields, option
// validation, and the per-field activity rows.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

interface RecordDetail {
  id: string
  typeKey: string
  name: string
  status: string | null
  fields: Record<string, unknown>
}

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

async function createContact(
  opts: ReturnType<typeof withOrgHeader>,
  fields: Record<string, unknown>
): Promise<RecordDetail> {
  return await $fetch<RecordDetail>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields },
    ...opts
  })
}

describe('POST /api/records/entries/contacts (create pipeline)', () => {
  it('creates with promoted + jsonb fields and applies the status default', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records Ada', nickname: 'Ada' })
    expect(rec.name).toBe('test-records Ada')
    // The manifest declares default: 'new' on the status field.
    expect(rec.status).toBe('new')
    expect(rec.fields.nickname).toBe('Ada')
  })

  it('400s when the required name is missing or empty', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const missing = await createContact(opts, {}).catch(e => e)
    expect(missing.statusCode).toBe(400)
    const empty = await createContact(opts, { name: '  ' }).catch(e => e)
    expect(empty.statusCode).toBe(400)
  })

  it('400s on unknown fields', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const err = await createContact(opts, { name: 'test-records X', bogus: 1 }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('400s on key_select values outside the option vocabulary', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const err = await createContact(opts, { name: 'test-records X', status: 'bogus' }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })
})

describe('PATCH /api/records/entries/contacts/:id (jsonb)', () => {
  it('sets a jsonb key and removes it on null', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records Jane', nickname: 'Janey' })

    const cleared = await $fetch<RecordDetail>(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { nickname: null } },
      ...opts
    })
    expect(cleared.fields.nickname).toBeNull()

    // null means delete-the-key, not store-a-null.
    const rows = await sql`SELECT data FROM records_entries WHERE id = ${rec.id}`
    expect(Object.keys(rows[0]!.data as Record<string, unknown>)).not.toContain('nickname')
  })
})

describe('rich text fields', () => {
  it('stores Markdown as written, clears on empty text, and refuses non-strings and oversized text', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const patch = (id: string, description: unknown) => $fetch<RecordDetail>(`/api/records/entries/task/${id}`, {
      method: 'PATCH',
      body: { fields: { description } },
      ...opts
    })
    const markdown = '# Plan\n\n- one\n- **two**\n\nSee [@ id="task/00000000-0000-4000-8000-000000000000" label="Other" char="#"]'
    const task = await $fetch<RecordDetail>('/api/records/entries/task', {
      method: 'POST',
      body: { fields: { name: 'test-records Write the plan', description: markdown } },
      ...opts
    })
    expect(task.fields.description).toBe(markdown)

    expect((await patch(task.id, '   ')).fields.description).toBeNull()
    expect((await patch(task.id, { html: '<b>x</b>' }).catch(e => e)).statusCode).toBe(400)
    expect((await patch(task.id, 'x'.repeat(100_001)).catch(e => e)).statusCode).toBe(400)

    const found = await $fetch<{ items: Array<{ id: string }> }>('/api/records/entries/task', {
      query: { filters: JSON.stringify({ description: { contains: 'nothing like this' } }) },
      ...opts
    })
    expect(found.items).toEqual([])
  })
})

describe('rich text links to other records', () => {
  it('lists where a record is mentioned, to those who can open the mentioning record, and serves current names', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const task = (opts: typeof owner, fields: Record<string, unknown>, confirmShare = false) =>
      $fetch<RecordDetail>('/api/records/entries/task', { method: 'POST', body: { fields, confirmShare }, ...opts })
    const mentions = (opts: typeof owner, id: string) =>
      $fetch<{ items: Array<{ id: string, typeKey: string, name: string }> }>(`/api/records/entries/task/${id}/mentions`, opts)

    // Sam is assigned the target, so can open it; the card linking to it stays the owner's.
    const target = await task(owner, { name: 'test-records Target', assignee: [sam.user.id] }, true)
    const chip = `[@ id="task/${target.id}" label="An older name" char="#"]`
    const source = await task(owner, { name: 'test-records Source', description: `See ${chip} and ${chip}` })

    expect((await mentions(owner, target.id)).items).toEqual([{ id: source.id, typeKey: 'task', name: 'test-records Source' }])
    expect((await mentions(samOpts, target.id)).items).toEqual([])
    expect((await mentions(owner, source.id)).items).toEqual([])

    const names = await $fetch<{ items: Array<{ id: string, name: string }> }>('/api/records/names', {
      query: { ids: `${target.id},${source.id},not-an-id` },
      ...samOpts
    })
    expect(names.items).toEqual([{ id: target.id, typeKey: 'task', name: 'test-records Target' }])

    // A link to itself or to nothing isn't kept, and taking the link out forgets it.
    await $fetch(`/api/records/entries/task/${source.id}`, {
      method: 'PATCH',
      body: { fields: { description: `Now only [@ id="task/${source.id}" label="me" char="#"]` } },
      ...owner
    })
    expect((await mentions(owner, target.id)).items).toEqual([])
    expect((await mentions(owner, source.id)).items).toEqual([])
  })
})

describe('PATCH multi-value fields (entries)', () => {
  it('adds, removes, and force-replaces entry values', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records Multi' })

    // Add two values via the D.T-style list.
    let updated = await $fetch<RecordDetail>(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { languages: { values: [{ value: 'en' }, { value: 'es' }] } } },
      ...opts
    })
    expect(updated.fields.languages).toEqual(['en', 'es'])

    // Remove one.
    updated = await $fetch<RecordDetail>(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { languages: { values: [{ value: 'en', delete: true }] } } },
      ...opts
    })
    expect(updated.fields.languages).toEqual(['es'])

    // A plain array force-replaces the whole list.
    updated = await $fetch<RecordDetail>(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { languages: ['fr'] } },
      ...opts
    })
    expect(updated.fields.languages).toEqual(['fr'])
  })

  it('validates multi_select values against the option vocabulary', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records Opt' })
    const err = await $fetch(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { languages: ['klingon'] } },
      ...opts
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })
})

describe('PATCH user_select fields (user_refs, multiple)', () => {
  it('assigns multiple users and removes one', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const m1 = await addRecordsMember(sql, org.id, ['member'])
    const m2 = await addRecordsMember(sql, org.id, ['member'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records Assigned' })

    // Assigning people who can't see the contact yet shares it, so it asks first.
    const refused = await $fetch(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { assigned_to: [m1.user.id, m2.user.id] } },
      ...opts
    }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data.data.code).toBe('records.share_confirmation')
    expect(refused.data.data.users.map((u: { id: string }) => u.id).sort()).toEqual([m1.user.id, m2.user.id].sort())

    let updated = await $fetch<RecordDetail>(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { assigned_to: [m1.user.id, m2.user.id] }, confirmShare: true },
      ...opts
    })
    expect((updated.fields.assigned_to as string[]).sort()).toEqual([m1.user.id, m2.user.id].sort())

    updated = await $fetch<RecordDetail>(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { assigned_to: { values: [{ value: m1.user.id, delete: true }] } } },
      ...opts
    })
    expect(updated.fields.assigned_to).toEqual([m2.user.id])
  })

  it('400s on user ids that do not exist', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records BadRef' })
    const err = await $fetch(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { assigned_to: ['00000000-0000-4000-8000-000000000000'] } },
      ...opts
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })
})

describe('activity rows', () => {
  it('writes created on create and field_changed with full old/new on update', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records Audit', nickname: 'Before' })

    await $fetch(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { nickname: 'After' } },
      ...opts
    })

    const rows = await sql`
      SELECT action, field_key, old_value, new_value
      FROM records_activity WHERE record_id = ${rec.id}
      ORDER BY created_at ASC
    `
    expect(rows.find(r => r.action === 'created')).toBeDefined()
    const change = rows.find(r => r.action === 'field_changed' && r.field_key === 'nickname')
    expect(change).toBeDefined()
    expect(change!.old_value).toBe('Before')
    expect(change!.new_value).toBe('After')
  })

  it('writes no field_changed row when the value did not change', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records NoChange', nickname: 'Same' })

    await $fetch(`/api/records/entries/contacts/${rec.id}`, {
      method: 'PATCH',
      body: { fields: { nickname: 'Same' } },
      ...opts
    })

    const rows = await sql`
      SELECT id FROM records_activity
      WHERE record_id = ${rec.id} AND action = 'field_changed'
    `
    expect(rows).toHaveLength(0)
  })
})
