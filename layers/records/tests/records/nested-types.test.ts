// One type nested under another through a field pair made in the schema
// builder (tasks under an org's own "deliverable" type): the pair, the chain
// of ancestors across types, access coming down from the other type, the
// question before a move that shares, and what deleting the pair does.
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

const TYPE = 'test_deliverable'
/** The field on tasks naming their deliverable: the pair takes the type's key. */
const PARENT = TYPE
const CHILDREN = 'work'

interface RecordDetail {
  id: string
  fields: Record<string, unknown>
}
interface FieldDef {
  key: string
  label: string
  hierarchy: string | null
  reverseKey: string | null
  target: string | null
}

async function create(opts: Opts, type: string, fields: Record<string, unknown>): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}`, { method: 'POST', body: { fields }, ...opts })
}

async function patch(opts: Opts, type: string, id: string, fields: Record<string, unknown>, confirmShare = false): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}/${id}`, {
    method: 'PATCH',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function canSee(opts: Opts, type: string, id: string): Promise<boolean> {
  return await $fetch(`/api/records/entries/${type}/${id}`, opts).then(() => true, () => false)
}

const ids = (value: unknown) => (value as Array<{ id: string }>).map(v => v.id).sort()

async function ancestors(id: string): Promise<string[]> {
  const rows = await sql<Array<{ ancestor_ids: string[] }>>`SELECT ancestor_ids FROM records_entries WHERE id = ${id}`
  return rows[0]!.ancestor_ids
}

async function fieldsOf(opts: Opts, type: string): Promise<FieldDef[]> {
  return (await $fetch<{ fields: FieldDef[] }>(`/api/records/schema/types/${type}/fields`, opts)).fields
}

// An org whose admin made the type and nested tasks under it, plus two members.
async function setup() {
  const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
  const admin = withOrgHeader(auth, org.slug)
  await $fetch('/api/records/schema/types', {
    method: 'POST',
    body: { typeKey: TYPE, label: 'Deliverables', labelSingular: 'Deliverable' },
    ...admin
  })
  await $fetch(`/api/records/schema/types/${TYPE}/fields`, {
    method: 'POST',
    body: { fieldKey: CHILDREN, kind: 'connection', label: 'Work', target: 'task', nesting: 'children' },
    ...admin
  })
  const owner = await addRecordsMember(sql, org.id)
  const sam = await addRecordsMember(sql, org.id)
  return {
    admin,
    owner: withOrgHeader(owner.auth, org.slug),
    sam: withOrgHeader(sam.auth, org.slug),
    samId: sam.user.id
  }
}

describe('a type nested under another', () => {
  it('nesting makes a field on each type, and keeps the parent\'s key to itself', async () => {
    const { admin } = await setup()
    const own = (await fieldsOf(admin, TYPE)).find(f => f.key === CHILDREN)
    expect(own).toMatchObject({ hierarchy: 'children', target: 'task', reverseKey: PARENT })
    const pair = (await fieldsOf(admin, 'task')).find(f => f.key === PARENT)
    expect(pair).toMatchObject({ hierarchy: 'parent', target: TYPE, reverseKey: CHILDREN, label: 'Deliverable' })

    // Links are found by the parent field's key alone, so no other connection may use it.
    const clash = await $fetch('/api/records/schema/types/item/fields', {
      method: 'POST',
      body: { fieldKey: PARENT, kind: 'connection', label: 'Clash', target: TYPE },
      ...admin
    }).catch(e => e)
    expect(clash.statusCode).toBe(409)
    const twice = await $fetch(`/api/records/schema/types/${TYPE}/fields`, {
      method: 'POST',
      body: { fieldKey: 'more_work', kind: 'connection', label: 'More', target: 'task', nesting: 'children' },
      ...admin
    }).catch(e => e)
    expect(twice.statusCode).toBe(409)
  })

  it('a task sits under a deliverable or under a task, and its chain crosses the types', async () => {
    const { owner } = await setup()
    const big = await create(owner, TYPE, { name: 'test-records Rewrite' })
    const task = await create(owner, 'task', { name: 'test-records API', [PARENT]: [big.id] })
    const sub = await create(owner, 'task', { name: 'test-records Endpoints', parent: [task.id] })
    expect(await ancestors(task.id)).toEqual([big.id])
    expect(await ancestors(sub.id)).toEqual([big.id, task.id])

    const read = await $fetch<RecordDetail>(`/api/records/entries/${TYPE}/${big.id}`, owner)
    expect(ids(read.fields[CHILDREN])).toEqual([task.id])
    const direct = await $fetch<{ items: Array<{ id: string }> }>('/api/records/entries/task', {
      query: { filters: JSON.stringify({ [PARENT]: big.id }) },
      ...owner
    })
    expect(direct.items.map(i => i.id)).toEqual([task.id])

    // One parent: put under another task, it leaves the deliverable.
    const other = await create(owner, 'task', { name: 'test-records Elsewhere' })
    const moved = await patch(owner, 'task', task.id, { parent: [other.id] })
    expect(ids(moved.fields[PARENT])).toEqual([])
    expect(await ancestors(sub.id)).toEqual([other.id, task.id])

    // And back, written from the deliverable's side.
    await patch(owner, TYPE, big.id, { [CHILDREN]: [task.id] })
    expect(await ancestors(sub.id)).toEqual([big.id, task.id])
    expect(ids((await $fetch<RecordDetail>(`/api/records/entries/task/${task.id}`, owner)).fields.parent)).toEqual([])
  })

  it('whoever can see a deliverable sees the tasks under it', async () => {
    const { owner, sam, samId } = await setup()
    const big = await create(owner, TYPE, { name: 'test-records Shared deliverable' })
    const task = await create(owner, 'task', { name: 'test-records Its task', [PARENT]: [big.id] })
    const sub = await create(owner, 'task', { name: 'test-records Its subtask', parent: [task.id] })
    expect(await canSee(sam, 'task', sub.id)).toBe(false)

    await $fetch(`/api/records/entries/${TYPE}/${big.id}/shares`, { method: 'POST', body: { userId: samId }, ...owner })
    expect(await canSee(sam, 'task', task.id)).toBe(true)
    expect(await canSee(sam, 'task', sub.id)).toBe(true)

    // The subtask's share list says where the access comes from.
    const list = await $fetch<{ via: Array<{ sourceId: string, label: string, path: string }> }>(
      `/api/records/entries/task/${sub.id}/shares`, owner)
    expect(list.via).toEqual([expect.objectContaining({
      sourceId: 'records:ancestor',
      label: 'test-records Shared deliverable',
      path: `/records/${TYPE}/${big.id}`
    })])

    // An existing task moved under it asks first.
    const loose = await create(owner, 'task', { name: 'test-records Loose task' })
    const refused = await patch(owner, 'task', loose.id, { [PARENT]: [big.id] }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data.data).toMatchObject({ code: 'records.share_confirmation' })
    expect(await canSee(sam, 'task', loose.id)).toBe(false)
    await patch(owner, 'task', loose.id, { [PARENT]: [big.id] }, true)
    expect(await canSee(sam, 'task', loose.id)).toBe(true)
  })

  it('deleting the nesting field takes its pair and the links, and the access with them', async () => {
    const { admin, owner, sam, samId } = await setup()
    const big = await create(owner, TYPE, { name: 'test-records Going flat' })
    const task = await create(owner, 'task', { name: 'test-records Task', [PARENT]: [big.id] })
    const sub = await create(owner, 'task', { name: 'test-records Subtask', parent: [task.id] })
    await $fetch(`/api/records/entries/${TYPE}/${big.id}/shares`, { method: 'POST', body: { userId: samId }, ...owner })
    expect(await canSee(sam, 'task', sub.id)).toBe(true)

    await $fetch(`/api/records/schema/types/${TYPE}/fields/${CHILDREN}`, { method: 'DELETE', ...admin })
    expect((await fieldsOf(admin, 'task')).some(f => f.key === PARENT)).toBe(false)
    expect(await ancestors(task.id)).toEqual([])
    expect(await ancestors(sub.id)).toEqual([task.id])
    expect(await canSee(sam, 'task', sub.id)).toBe(false)
    expect(await canSee(owner, 'task', sub.id)).toBe(true)
  })
})
