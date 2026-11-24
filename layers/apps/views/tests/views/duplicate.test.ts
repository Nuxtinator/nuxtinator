// Duplicating a card from a view: the copy is the caller's new record with
// the original's fields, shares and subtasks (in their order, closed ones
// reopened), its parent and place under it, and on the view itself its own
// values and places, which only the view's editors carry over.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  addViewsMember,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Task {
  id: string
  name: string
  status: string | null
  fields: Record<string, unknown>
}

async function createTask(opts: Opts, fields: Record<string, unknown>, confirmShare = false): Promise<Task> {
  return await $fetch<Task>('/api/records/entries/task', {
    method: 'POST',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function getTask(opts: Opts, id: string): Promise<Task> {
  return await $fetch<Task>(`/api/records/entries/task/${id}`, opts)
}

async function children(opts: Opts, parentId: string): Promise<Array<{ name: string, status: string | null }>> {
  const res = await $fetch<{ items: Array<{ name: string, status: string | null }> }>('/api/records/entries/task', {
    query: { filters: JSON.stringify({ parent: parentId }), sort: 'position' },
    ...opts
  })
  return res.items.map(i => ({ name: i.name, status: i.status }))
}

async function duplicate(opts: Opts, viewId: string, recordId: string): Promise<string> {
  const res = await $fetch<{ id: string }>(`/api/views/${viewId}/cards/${recordId}/duplicate`, { method: 'POST', ...opts })
  return res.id
}

function move(opts: Opts, viewId: string, body: Record<string, unknown>) {
  return $fetch(`/api/views/${viewId}/move`, { method: 'POST', body, ...opts })
}

async function taskView(opts: Opts): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/views', {
    method: 'POST',
    body: { name: 'test-views Tasks', recordTypeKey: 'task', tab: { layout: 'kanban', definition: { groupField: 'status' } } },
    ...opts
  })
}

describe('duplicating a card', () => {
  it('copies the record with its fields, assignees and subtasks in order, reopening closed ones', async () => {
    const { org, user, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const view = await taskView(owner)

    const plan = await createTask(owner, {
      name: 'test-views Plan',
      status: 'in_progress',
      priority: 'high',
      tags: ['launch'],
      assignee: [sam.user.id]
    }, true)
    const a = await createTask(owner, { name: 'test-views a', parent: [plan.id] })
    const b = await createTask(owner, { name: 'test-views b', parent: [plan.id], status: 'done' })
    const c = await createTask(owner, { name: 'test-views c', parent: [plan.id] })
    const board = await $fetch<{ tabs: Array<{ id: string }> }>(`/api/views/builtin.subtasks.${plan.id}`, owner)
    await move(owner, `builtin.subtasks.${plan.id}`, { tabId: board.tabs[0]!.id, recordId: c.id, fromColumn: 'open', toColumn: 'open', columnOrder: [c.id, a.id] })
    expect((await children(owner, plan.id)).map(t => t.name)).toEqual(['test-views c', 'test-views a', 'test-views b'])

    const copyId = await duplicate(owner, view.id, plan.id)
    expect(copyId).not.toBe(plan.id)
    const copy = await getTask(owner, copyId)
    expect(copy.name).toBe('test-views Plan')
    expect(copy.status).toBe('in_progress')
    expect(copy.fields.priority).toBe('high')
    expect(copy.fields.tags).toEqual(['launch'])
    expect(copy.fields.assignee).toEqual([sam.user.id])

    expect(await children(owner, copyId)).toEqual([
      { name: 'test-views c', status: 'open' },
      { name: 'test-views a', status: 'open' },
      { name: 'test-views b', status: 'open' }
    ])
    expect((await children(owner, plan.id)).map(t => t.name)).toEqual(['test-views c', 'test-views a', 'test-views b'])
    expect((await getTask(owner, b.id)).status).toBe('done')

    // The assignee sees the copy; the copy is the duplicator's, and says what it came from.
    expect((await getTask(withOrgHeader(sam.auth, org.slug), copyId)).id).toBe(copyId)
    const [row] = await sql<Array<{ created_by: string }>>`select created_by from records_entries where id = ${copyId}`
    expect(row!.created_by).toBe(user.id)
    const activity = await sql<Array<{ action: string }>>`select action from records_activity where record_id = ${copyId}`
    expect(activity.map(r => r.action)).toContain('duplicated')
  })

  it('puts a subtask\'s copy right after it under the same parent', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const parent = await createTask(owner, { name: 'test-views Feature' })
    const a = await createTask(owner, { name: 'test-views a', parent: [parent.id] })
    const b = await createTask(owner, { name: 'test-views b', parent: [parent.id] })
    const c = await createTask(owner, { name: 'test-views c', parent: [parent.id] })
    const viewId = `builtin.subtasks.${parent.id}`
    const board = await $fetch<{ tabs: Array<{ id: string }> }>(`/api/views/${viewId}`, owner)
    await move(owner, viewId, { tabId: board.tabs[0]!.id, recordId: a.id, fromColumn: 'open', toColumn: 'open', columnOrder: [a.id, b.id, c.id] })

    await duplicate(owner, viewId, b.id)
    expect((await children(owner, parent.id)).map(t => t.name)).toEqual(['test-views a', 'test-views b', 'test-views b', 'test-views c'])
  })

  it('on a hand-picked view makes one of its own cards, with its values and place, for its editors only', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const viewer = await addViewsMember(sql, org.id)
    const view = await $fetch<{ id: string, tabs: Array<{ id: string }> }>('/api/views', {
      method: 'POST',
      body: {
        name: 'test-views Pizza',
        recordTypeKey: 'item',
        definition: { picked: true },
        tab: { layout: 'kanban', definition: { columns: [{ key: 'todo', label: 'To do' }, { key: 'doing', label: 'Doing' }] } }
      },
      ...owner
    })
    const field = (await $fetch<{ field: { key: string } }>(`/api/views/${view.id}/fields`, {
      method: 'POST',
      body: { label: 'Tried', kind: 'boolean' },
      ...owner
    })).field
    const card = async (name: string, extra: Record<string, unknown> = {}) =>
      (await $fetch<{ id: string }>(`/api/views/${view.id}/cards`, {
        method: 'POST',
        body: { fields: { name }, tabId: view.tabs[0]!.id, columnKey: 'doing', ...extra },
        ...owner
      })).id
    const first = await card('test-views Margherita', { viewValues: { [field.key]: true } })
    const second = await card('test-views Funghi')

    const copyId = await duplicate(owner, view.id, first)
    const feed = await $fetch<{
      items: Array<{ id: string, ownCard?: true, viewValues?: Record<string, unknown> }>
      placements: Array<{ recordId: string, columnKey: string, rank: string | null }>
    }>(`/api/views/${view.id}/records`, owner)
    const copy = feed.items.find(i => i.id === copyId)!
    expect(copy.ownCard).toBe(true)
    expect(copy.viewValues).toEqual({ [field.key]: true })
    const doing = feed.placements
      .filter(p => p.columnKey === 'doing')
      .sort((x, y) => (x.rank! < y.rank! ? -1 : 1))
      .map(p => p.recordId)
    expect(doing).toEqual([first, copyId, second])

    await $fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: viewer.user.id, level: 'view' }, ...owner })
    await expect(duplicate(withOrgHeader(viewer.auth, org.slug), view.id, first)).rejects.toMatchObject({ statusCode: 403 })
  })
})
