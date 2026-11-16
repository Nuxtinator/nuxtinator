// Task trees. A task has one parent, whichever side the link was written
// from; loops are refused; every task carries its chain of ancestors, kept
// right through moves and deletes. Whoever can see a task sees everything
// under it, so moving an existing task under one other people can see asks
// first, and linking a task from its parent's side takes access to it.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
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

async function create(opts: Opts, fields: Record<string, unknown>): Promise<RecordDetail> {
  return await $fetch<RecordDetail>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })
}

async function patch(opts: Opts, id: string, fields: Record<string, unknown>, confirmShare = false): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/task/${id}`, {
    method: 'PATCH',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function get(opts: Opts, id: string): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/task/${id}`, opts)
}

async function canSee(opts: Opts, id: string): Promise<boolean> {
  return await get(opts, id).then(() => true, () => false)
}

const ids = (value: unknown) => (value as Array<{ id: string }>).map(v => v.id).sort()

async function ancestors(id: string): Promise<string[]> {
  const rows = await sql<Array<{ ancestor_ids: string[] }>>`SELECT ancestor_ids FROM records_entries WHERE id = ${id}`
  return rows[0]!.ancestor_ids
}

describe('task hierarchy', () => {
  it('a link written from either side makes one parent, read from both', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const parent = await create(me, { name: 'test-records Launch' })
    const a = await create(me, { name: 'test-records Write copy', parent: [parent.id] })
    const b = await create(me, { name: 'test-records Book venue' })

    await patch(me, parent.id, { subtasks: [a.id, b.id] })
    expect(ids((await get(me, parent.id)).fields.subtasks)).toEqual([a.id, b.id].sort())
    expect(ids((await get(me, b.id)).fields.parent)).toEqual([parent.id])
    expect(await ancestors(b.id)).toEqual([parent.id])

    // A second parent replaces the first.
    const other = await create(me, { name: 'test-records Other project' })
    await patch(me, b.id, { parent: [other.id] })
    expect(ids((await get(me, parent.id)).fields.subtasks)).toEqual([a.id])
    expect(ids((await get(me, other.id)).fields.subtasks)).toEqual([b.id])
    const two = await patch(me, b.id, { parent: [parent.id, other.id] }).catch(e => e)
    expect(two.statusCode).toBe(400)

    // Dropping a subtask from the parent's list makes it a root again.
    await patch(me, parent.id, { subtasks: [] })
    expect((await get(me, a.id)).fields.parent).toEqual([])
    expect(await ancestors(a.id)).toEqual([])
  })

  it('refuses loops', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const a = await create(me, { name: 'test-records A' })
    const b = await create(me, { name: 'test-records B', parent: [a.id] })
    const c = await create(me, { name: 'test-records C', parent: [b.id] })

    expect((await patch(me, a.id, { parent: [a.id] }).catch(e => e)).statusCode).toBe(400)
    expect((await patch(me, a.id, { parent: [c.id] }).catch(e => e)).statusCode).toBe(400)
    expect((await patch(me, c.id, { subtasks: [a.id] }).catch(e => e)).statusCode).toBe(400)
    expect(await ancestors(c.id)).toEqual([a.id, b.id])
  })

  it('a move rewrites the chain of everything under it, and a delete cuts it', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const me = withOrgHeader(auth, org.slug)
    const a = await create(me, { name: 'test-records A' })
    const b = await create(me, { name: 'test-records B', parent: [a.id] })
    const c = await create(me, { name: 'test-records C', parent: [b.id] })
    const d = await create(me, { name: 'test-records D', parent: [c.id] })
    const x = await create(me, { name: 'test-records X' })
    expect(await ancestors(d.id)).toEqual([a.id, b.id, c.id])

    await patch(me, b.id, { parent: [x.id] })
    expect(await ancestors(b.id)).toEqual([x.id])
    expect(await ancestors(d.id)).toEqual([x.id, b.id, c.id])

    await $fetch(`/api/records/entries/task/${b.id}`, { method: 'DELETE', ...me })
    expect(await ancestors(c.id)).toEqual([])
    expect(await ancestors(d.id)).toEqual([c.id])
  })

  it('whoever can see a task sees everything under it', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)

    const project = await create(owner, { name: 'test-records Rewrite' })
    const phase = await create(owner, { name: 'test-records Phase 1', parent: [project.id] })
    const step = await create(owner, { name: 'test-records Schema', parent: [phase.id] })
    const elsewhere = await create(owner, { name: 'test-records Private errand' })
    expect(await canSee(samOpts, step.id)).toBe(false)

    await $fetch(`/api/records/entries/task/${project.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })
    expect(await canSee(samOpts, project.id)).toBe(true)
    expect(await canSee(samOpts, phase.id)).toBe(true)
    expect(await canSee(samOpts, step.id)).toBe(true)
    expect(await canSee(samOpts, elsewhere.id)).toBe(false)
    const listed = await $fetch<{ items: Array<{ id: string }> }>('/api/records/entries/task', samOpts)
    expect(listed.items.map(i => i.id).sort()).toEqual([project.id, phase.id, step.id].sort())

    // Access comes down from above only: a task under a shared one doesn't open its parent.
    await $fetch(`/api/records/entries/task/${project.id}/shares/${sam.user.id}`, { method: 'DELETE', ...owner })
    await $fetch(`/api/records/entries/task/${phase.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })
    expect(await canSee(samOpts, project.id)).toBe(false)
    expect(await canSee(samOpts, step.id)).toBe(true)

    // Taken out of the tree, a task stops being seen through it.
    await patch(owner, step.id, { parent: [] })
    expect(await canSee(samOpts, step.id)).toBe(false)
  })

  it('moving an existing task under one other people can see asks first', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const project = await create(owner, { name: 'test-records Shared project' })
    await $fetch(`/api/records/entries/task/${project.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })

    // A subtask created there is meant for it.
    const born = await create(owner, { name: 'test-records Born here', parent: [project.id] })

    const loose = await create(owner, { name: 'test-records Loose task' })
    const refused = await patch(owner, loose.id, { parent: [project.id] }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data.data).toMatchObject({ code: 'records.share_confirmation', users: [] })
    expect(refused.data.data.title).toContain('Shared project')
    expect(await ancestors(loose.id)).toEqual([])
    await patch(owner, loose.id, { parent: [project.id] }, true)
    expect(await ancestors(loose.id)).toEqual([project.id])

    // Inside the tree, and under a task nobody else sees, a move just saves.
    await patch(owner, loose.id, { parent: [born.id] })
    expect(await ancestors(loose.id)).toEqual([project.id, born.id])
    const mine = await create(owner, { name: 'test-records Mine' })
    const alsoMine = await create(owner, { name: 'test-records Also mine' })
    await patch(owner, alsoMine.id, { parent: [mine.id] })
    expect(await ancestors(alsoMine.id)).toEqual([mine.id])
  })

  it('a move between branches of one tree asks when the new branch is shared', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const root = await create(owner, { name: 'test-records Root' })
    const shared = await create(owner, { name: 'test-records Shared branch', parent: [root.id] })
    const quiet = await create(owner, { name: 'test-records Quiet branch', parent: [root.id] })
    const task = await create(owner, { name: 'test-records Quiet task', parent: [quiet.id] })
    const below = await create(owner, { name: 'test-records Below it', parent: [task.id] })
    await $fetch(`/api/records/entries/task/${shared.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })

    const refused = await patch(owner, task.id, { parent: [shared.id] }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data.data).toMatchObject({ code: 'records.share_confirmation' })
    expect(await canSee(samOpts, below.id)).toBe(false)
    await patch(owner, task.id, { parent: [shared.id] }, true)
    expect(await canSee(samOpts, below.id)).toBe(true)

    // Up to a task already above it: nobody new sees it.
    await patch(owner, below.id, { parent: [shared.id] })
    expect(await ancestors(below.id)).toEqual([root.id, shared.id])
  })

  it('moves made at the same moment can\'t make a loop or a second parent', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const a = await create(me, { name: 'test-records A' })
    const b = await create(me, { name: 'test-records B' })
    const loop = await Promise.allSettled([
      patch(me, a.id, { parent: [b.id] }),
      patch(me, b.id, { parent: [a.id] })
    ])
    expect(loop.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect([...await ancestors(a.id), ...await ancestors(b.id)]).toHaveLength(1)

    const child = await create(me, { name: 'test-records Child' })
    const one = await create(me, { name: 'test-records One' })
    const two = await create(me, { name: 'test-records Two' })
    await Promise.allSettled([
      patch(me, child.id, { parent: [one.id] }),
      patch(me, child.id, { parent: [two.id] })
    ])
    const parents = await sql<Array<{ to_record_id: string }>>`
      SELECT to_record_id FROM records_connections WHERE from_record_id = ${child.id} AND field_key = 'parent'
    `
    expect(parents).toHaveLength(1)
    expect(await ancestors(child.id)).toEqual([parents[0]!.to_record_id])
  })

  it('a subtask\'s share list shows the access that comes from above', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const project = await create(owner, { name: 'test-records Shared project' })
    const child = await create(owner, { name: 'test-records Child', parent: [project.id] })
    await $fetch(`/api/records/entries/task/${project.id}/shares`, { method: 'POST', body: { userId: sam.user.id, level: 'edit' }, ...owner })

    const list = await $fetch<{ items: unknown[], via: Array<{ sourceId: string, label: string, audience: Array<{ level: string }> }> }>(
      `/api/records/entries/task/${child.id}/shares`, owner)
    expect(list.items).toEqual([])
    expect(list.via).toHaveLength(1)
    expect(list.via[0]).toMatchObject({ sourceId: 'records:ancestor', label: 'test-records Shared project' })
    expect(list.via[0]!.audience).toMatchObject([{ kind: 'user', level: 'edit' }])
  })

  it('a task can\'t be pulled under another by someone who can\'t see it', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const secret = await create(owner, { name: 'test-records Secret' })
    const bait = await create(samOpts, { name: 'test-records Bait' })

    expect((await patch(samOpts, bait.id, { subtasks: [secret.id] }).catch(e => e)).statusCode).toBe(400)
    expect((await patch(samOpts, bait.id, { parent: [secret.id] }).catch(e => e)).statusCode).toBe(400)
    expect(await ancestors(secret.id)).toEqual([])
    expect(await canSee(samOpts, secret.id)).toBe(false)
  })
})
