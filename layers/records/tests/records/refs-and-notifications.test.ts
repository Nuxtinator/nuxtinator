// Ref fields and assignment notifications. A ref holds the id of something
// another layer owns and reads back as that thing's label and link, as the
// caller sees it (the dev host's `test-items` fixture source points at item
// records). A person's write that newly names someone in an access-granting
// people field tells them, in the app and by email; system writes and
// self-assignment don't.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
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

async function notificationsFor(userId: string) {
  return await sql<Array<{ title: string, body: string | null, link: string, email_mode: string }>>`
    select title, body, link, email_mode from notifications where user_id = ${userId} order by created_at`
}

describe('ref fields', () => {
  it('reads back as the target\'s label and link, hidden or missing as the caller sees it', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)

    const item = await create(owner, 'item', { name: 'test-records Oven notes' })
    const task = await create(owner, 'task', { name: 'test-records Preheat', test_item: item.id })
    expect(task.fields.test_item).toEqual({ id: item.id, label: 'test-records Oven notes', url: `/records/item/${item.id}` })

    // Sam sees the task (shared) but not the item behind its ref.
    await $fetch(`/api/records/entries/task/${task.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })
    const seen = await $fetch<RecordDetail>(`/api/records/entries/task/${task.id}`, samOpts)
    expect(seen.fields.test_item).toEqual({ id: item.id, label: '', hidden: true })

    await sql`delete from records_entries where id = ${item.id}`
    const after = await $fetch<RecordDetail>(`/api/records/entries/task/${task.id}`, owner)
    expect(after.fields.test_item).toEqual({ id: item.id, label: '', missing: true })
  })

  it('refuses a target the caller can\'t see or that doesn\'t exist, and clears with null', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)

    const hidden = await create(owner, 'item', { name: 'test-records Private item' })
    const refused = await create(samOpts, 'task', { name: 'test-records Sneaky', test_item: hidden.id }).catch(e => e)
    expect(refused.statusCode).toBe(400)
    const missing = await create(owner, 'task', { name: 'test-records Nothing', test_item: randomUUID() }).catch(e => e)
    expect(missing.statusCode).toBe(400)

    const own = await create(samOpts, 'item', { name: 'test-records Sam item' })
    const task = await create(samOpts, 'task', { name: 'test-records Fine', test_item: { id: own.id, label: 'ignored' } })
    expect((task.fields.test_item as { id: string }).id).toBe(own.id)
    expect((await patch(samOpts, 'task', task.id, { test_item: null })).fields.test_item).toBeNull()
  })

  it('filters by ref, and the lookup route lists and resolves targets', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const a = await create(owner, 'item', { name: 'test-records Alpha' })
    const b = await create(owner, 'item', { name: 'test-records Beta' })
    await create(owner, 'task', { name: 'test-records On alpha', test_item: a.id })
    await create(owner, 'task', { name: 'test-records On beta', test_item: b.id })
    await create(owner, 'task', { name: 'test-records On nothing' })

    const onAlpha = await $fetch<{ items: Array<{ name: string }> }>('/api/records/entries/task', {
      query: { filters: JSON.stringify({ test_item: a.id }) },
      ...owner
    })
    expect(onAlpha.items.map(i => i.name)).toEqual(['test-records On alpha'])
    const unset = await $fetch<{ items: Array<{ name: string }> }>('/api/records/entries/task', {
      query: { filters: JSON.stringify({ test_item: null }) },
      ...owner
    })
    expect(unset.items.map(i => i.name)).toEqual(['test-records On nothing'])

    const search = await $fetch<{ items: Array<{ id: string, label: string }> }>('/api/records/refs/test-items', {
      query: { q: 'alph' },
      ...owner
    })
    expect(search.items).toEqual([{ id: a.id, label: 'test-records Alpha' }])
    const byIds = await $fetch<{ items: unknown[] }>('/api/records/refs/test-items', {
      query: { ids: `${b.id},${a.id}` },
      ...owner
    })
    expect(byIds.items).toEqual([
      { id: b.id, label: 'test-records Beta', url: `/records/item/${b.id}` },
      { id: a.id, label: 'test-records Alpha', url: `/records/item/${a.id}` }
    ])
    const unknown = await $fetch('/api/records/refs/nope', owner).catch(e => e)
    expect(unknown.statusCode).toBe(404)
  })
})

describe('assignment notifications', () => {
  it('tells a new assignee, in the app and by email, but not someone assigning themselves', async () => {
    const { org, auth, user } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)

    const task = await create(owner, 'task', { name: 'test-records Order flour', assignee: sam.user.id }, true)
    const sent = await notificationsFor(sam.user.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      title: `${user.display_name} assigned you a task`,
      body: 'test-records Order flour',
      link: `/records/task/${task.id}`,
      email_mode: 'immediate'
    })

    // Unchanged assignee, other edits: nothing new.
    await patch(owner, 'task', task.id, { name: 'test-records Order more flour', assignee: sam.user.id })
    expect(await notificationsFor(sam.user.id)).toHaveLength(1)

    await patch(owner, 'task', task.id, { assignee: user.id })
    expect(await notificationsFor(user.id)).toHaveLength(0)

    // Back to Sam, who lost sight of it meanwhile: a new assignment again.
    await patch(owner, 'task', task.id, { assignee: sam.user.id }, true)
    expect(await notificationsFor(sam.user.id)).toHaveLength(2)
  })

  it('doesn\'t notify for people fields that don\'t hand the record over', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    await create(owner, 'item', { name: 'test-records Party', people: [sam.user.id] })
    expect(await notificationsFor(sam.user.id)).toHaveLength(0)
  })
})
