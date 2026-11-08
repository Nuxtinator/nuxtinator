// Who a people field lets in, and the confirmation before it does. Only
// fields declared as handing a record to someone (task assignee, contacts'
// assigned to) make it visible to the people they name; an item's People
// field only records who's involved. A write that names someone who can't
// otherwise see the record is refused (409) until resent confirmed, over
// HTTP and MCP alike. Plus attachments fields: hydration, removal queueing
// the stored object for deletion, and presence filters.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface RecordDetail {
  id: string
  fields: Record<string, unknown>
}

async function create(opts: Opts, type: string, fields: Record<string, unknown>, confirmShare = false): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}`, {
    method: 'POST',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function patch(opts: Opts, type: string, id: string, fields: Record<string, unknown>, confirmShare = false): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}/${id}`, {
    method: 'PATCH',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function canSee(opts: Opts, type: string, id: string): Promise<boolean> {
  try {
    await $fetch(`/api/records/entries/${type}/${id}`, opts)
    return true
  } catch {
    return false
  }
}

describe('people fields and access', () => {
  it('an assignee sees the task; someone in an item\'s People field doesn\'t see the item', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)

    const item = await create(owner, 'item', { name: 'test-records Pizza night', people: [sam.user.id] })
    expect(item.fields.people).toEqual([sam.user.id])
    expect(await canSee(samOpts, 'item', item.id)).toBe(false)

    const task = await create(owner, 'task', { name: 'test-records Buy flour', assignee: sam.user.id }, true)
    expect(await canSee(samOpts, 'task', task.id)).toBe(true)
  })

  it('asks before assigning someone who can\'t see the record, and not otherwise', async () => {
    const { org, auth, user } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const task = await create(owner, 'task', { name: 'test-records Book the oven' })

    const refused = await patch(owner, 'task', task.id, { assignee: sam.user.id }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data.data).toMatchObject({ code: 'records.share_confirmation', users: [{ id: sam.user.id }] })
    expect((await $fetch<RecordDetail>(`/api/records/entries/task/${task.id}`, owner)).fields.assignee).toBeNull()

    expect((await patch(owner, 'task', task.id, { assignee: sam.user.id }, true)).fields.assignee).toBe(sam.user.id)
    // Assigning yourself, or someone the record is already shared with, just saves.
    expect((await patch(owner, 'task', task.id, { assignee: user.id })).fields.assignee).toBe(user.id)
    const other = await addRecordsMember(sql, org.id)
    await $fetch(`/api/records/entries/task/${task.id}/shares`, { method: 'POST', body: { userId: other.user.id }, ...owner })
    expect((await patch(owner, 'task', task.id, { assignee: other.user.id })).fields.assignee).toBe(other.user.id)
  })

  it('an MCP write that would share needs share: true', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['member'])
    const sam = await addRecordsMember(sql, org.id)
    const { token } = await issueMcpBearer(sql, user.id, ['records.read', 'records.write'])

    const refused = await callMcpTool(token, 'records_create', {
      org: org.slug,
      type: 'task',
      fields: { name: 'test-records Agent task', assignee: sam.user.id }
    })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(/can't see this task yet/)

    const created = await callMcpTool(token, 'records_create', {
      org: org.slug,
      type: 'task',
      fields: { name: 'test-records Agent task', assignee: sam.user.id },
      share: true
    })
    expect(created.isError).toBeFalsy()
  })
})

describe('attachments fields', () => {
  async function seedFile(orgId: string, recordId: string, name: string, order: number): Promise<string> {
    const id = randomUUID()
    await sql`
      INSERT INTO records_attachments (id, record_id, field_key, storage_key, filename, mime, size_bytes, sort_order, org_id)
      VALUES (${id}, ${recordId}, 'attachments', ${`records/test-records-${id}.png`}, ${name}, 'image/png', 1234, ${order}, ${orgId})
    `
    return id
  }

  it('hydrates files in order, removes them through a patch, and filters by presence', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const withFiles = await create(owner, 'item', { name: 'test-records Photos' })
    const without = await create(owner, 'item', { name: 'test-records No photos' })
    const first = await seedFile(org.id, withFiles.id, 'crust.png', 0)
    const second = await seedFile(org.id, withFiles.id, 'oven.png', 1)

    const detail = await $fetch<RecordDetail>(`/api/records/entries/item/${withFiles.id}`, owner)
    const files = detail.fields.attachments as Array<{ id: string, name: string, mime: string, size: number, url: string }>
    expect(files.map(f => f.name)).toEqual(['crust.png', 'oven.png'])
    expect(files[0]).toMatchObject({ id: first, mime: 'image/png', size: 1234 })
    expect(files[0]!.url).toMatch(/^https?:\/\//)

    const none = await $fetch<{ items: Array<{ id: string }> }>('/api/records/entries/item', {
      ...owner,
      query: { filters: JSON.stringify({ attachments: null }) }
    })
    expect(none.items.map(i => i.id)).toEqual([without.id])

    // A file can't be added by id, only by upload.
    await expect(patch(owner, 'item', withFiles.id, { attachments: [first, randomUUID()] })).rejects.toMatchObject({ statusCode: 400 })

    // Only plain images open in the browser; anything else downloads as bytes.
    const page = await seedFile(org.id, withFiles.id, 'page.html', 2)
    await sql`UPDATE records_attachments SET mime = 'text/html' WHERE id = ${page}`
    const served = (await $fetch<RecordDetail>(`/api/records/entries/item/${withFiles.id}`, owner)).fields.attachments as Array<{ id: string, url: string }>
    const html = new URL(served.find(f => f.id === page)!.url)
    expect(html.searchParams.get('response-content-type')).toBe('application/octet-stream')
    expect(html.searchParams.get('response-content-disposition')).toMatch(/^attachment;/)
    expect(new URL(served.find(f => f.id === first)!.url).searchParams.get('response-content-disposition')).toMatch(/^inline;/)
    await sql`DELETE FROM records_attachments WHERE id = ${page}`

    const kept = await patch(owner, 'item', withFiles.id, { attachments: [second] })
    expect((kept.fields.attachments as Array<{ id: string }>).map(f => f.id)).toEqual([second])
    const queued = await sql`SELECT 1 FROM records_attachment_trash WHERE storage_key = ${`records/test-records-${first}.png`}`
    expect(queued).toHaveLength(1)
    await sql`DELETE FROM records_attachment_trash WHERE storage_key LIKE 'records/test-records-%'`
  })
})

describe('required files', () => {
  it('a files field can\'t be made required, since files arrive after the record exists', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    await expect($fetch('/api/records/schema/types/item/fields', {
      method: 'POST',
      body: { fieldKey: 'receipts', kind: 'attachments', label: 'Receipts', required: true },
      ...owner
    })).rejects.toMatchObject({ statusCode: 400 })
    await expect($fetch('/api/records/schema/types/item/fields/attachments', {
      method: 'PATCH',
      body: { required: true },
      ...owner
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
