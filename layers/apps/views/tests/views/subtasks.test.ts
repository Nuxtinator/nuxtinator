// A task's subtasks board: the built-in view `builtin.subtasks.<taskId>`.
// Its Board tab shows the task's direct subtasks, its All levels tab
// everything under it; it names the tasks above it as a trail; it opens for
// whoever can open the task; and a top-level view can leave subtasks out by
// filtering on an empty parent.
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

interface Detail {
  id: string
  name: string
  builtIn: boolean
  recordId: string | null
  trail: Array<{ id: string, name: string }>
  definition: { filter?: unknown }
  tabs: Array<{ id: string, name: string, layout: string, definition: { filter?: unknown } }>
}

interface Feed {
  items: Array<{ id: string, name: string, progress?: Record<string, { total: number, done: number }> }>
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })
}

async function feed(opts: Opts, viewId: string, tabId: string): Promise<string[]> {
  const res = await $fetch<Feed>(`/api/views/${viewId}/records`, { query: { tab: tabId }, ...opts })
  return res.items.map(i => i.name).sort()
}

describe('subtasks board', () => {
  it('shows a task\'s direct subtasks, everything under it, and the tasks above it', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const project = await createTask(me, { name: 'test-views Rewrite' })
    const api = await createTask(me, { name: 'test-views API', parent: [project.id] })
    await createTask(me, { name: 'test-views Docs', parent: [project.id], status: 'done' })
    const auth1 = await createTask(me, { name: 'test-views Auth endpoints', parent: [api.id] })
    await createTask(me, { name: 'test-views Unrelated' })

    const top = await $fetch<Detail>(`/api/views/builtin.subtasks.${project.id}`, me)
    expect(top).toMatchObject({ name: 'test-views Rewrite', builtIn: true, recordId: project.id, recordType: 'task', trail: [] })
    const [board, all] = top.tabs
    expect(board).toMatchObject({ name: 'Board', layout: 'kanban' })
    expect(await feed(me, top.id, board!.id)).toEqual(['test-views API', 'test-views Docs'])
    expect(await feed(me, top.id, all!.id)).toEqual(['test-views API', 'test-views Auth endpoints', 'test-views Docs'])

    // A subtask opens the same way, one level down, with what leads to it.
    const inner = await $fetch<Detail>(`/api/views/builtin.subtasks.${auth1.id}`, me)
    expect(inner.trail).toEqual([
      { id: `builtin.subtasks.${project.id}`, name: 'test-views Rewrite' },
      { id: `builtin.subtasks.${api.id}`, name: 'test-views API' }
    ])
    expect(await feed(me, inner.id, inner.tabs[0]!.id)).toEqual([])

    // Built-in views aren't listed per task, and can't be changed.
    const list = await $fetch<{ builtIns: Array<{ id: string }> }>('/api/views', me)
    expect(list.builtIns.some(v => v.id.startsWith('builtin.subtasks'))).toBe(false)
    const patched = await $fetch(`/api/views/${top.id}`, { method: 'PATCH', body: { name: 'x' }, ...me }).catch(e => e)
    expect(patched.statusCode).toBe(403)
  })

  it('opens for whoever can open the task, and nobody else', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const project = await createTask(owner, { name: 'test-views Project' })
    const phase = await createTask(owner, { name: 'test-views Phase', parent: [project.id] })
    await createTask(owner, { name: 'test-views Step', parent: [phase.id] })

    const hidden = await $fetch(`/api/views/builtin.subtasks.${project.id}`, samOpts).catch(e => e)
    expect(hidden.statusCode).toBe(404)
    expect((await $fetch(`/api/views/builtin.subtasks.not-a-task`, owner).catch(e => e)).statusCode).toBe(404)

    // Shared from the middle: the board opens, and the task above stays out of its trail.
    await $fetch(`/api/records/entries/task/${phase.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })
    const view = await $fetch<Detail>(`/api/views/builtin.subtasks.${phase.id}`, samOpts)
    expect(view.trail).toEqual([])
    expect(await feed(samOpts, view.id, view.tabs[0]!.id)).toEqual(['test-views Step'])
  })

  it('an overview leaves subtasks out by filtering on an empty parent, and still shows their progress', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const big = await createTask(me, { name: 'test-views Big card' })
    await createTask(me, { name: 'test-views Small one', parent: [big.id], status: 'done' })
    await createTask(me, { name: 'test-views Small two', parent: [big.id] })

    const view = await $fetch<Detail>('/api/views', {
      method: 'POST',
      body: {
        name: 'test-views Overview',
        recordTypeKey: 'task',
        definition: { filter: { match: 'all', rules: [{ field: 'parent', op: 'empty' }] } },
        tab: { layout: 'kanban', definition: { groupField: 'status' } }
      },
      ...me
    })
    const res = await $fetch<Feed>(`/api/views/${view.id}/records`, { query: { tab: view.tabs[0]!.id }, ...me })
    expect(res.items.map(i => i.name)).toEqual(['test-views Big card'])
    expect(res.items[0]!.progress?.subtasks).toEqual({ total: 2, done: 1 })

    // Leaves are the tasks with nothing under them.
    await $fetch(`/api/views/${view.id}`, {
      method: 'PATCH',
      body: { definition: { filter: { match: 'all', rules: [{ field: 'subtasks', op: 'empty' }] } } },
      ...me
    })
    expect(await feed(me, view.id, view.tabs[0]!.id)).toEqual(['test-views Small one', 'test-views Small two'])
  })

  it('on a board grouped by parent, a drag moves the card to the new parent', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const project = await createTask(me, { name: 'test-views Project' })
    const a = await createTask(me, { name: 'test-views Phase A', parent: [project.id] })
    const b = await createTask(me, { name: 'test-views Phase B', parent: [project.id] })
    const card = await createTask(me, { name: 'test-views Card', parent: [a.id] })
    const view = await $fetch<Detail>('/api/views', {
      method: 'POST',
      body: { name: 'test-views By parent', recordTypeKey: 'task', tab: { layout: 'kanban', definition: { groupField: 'parent' } } },
      ...me
    })

    await $fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { recordId: card.id, fromColumn: a.id, toColumn: b.id, columnOrder: [card.id] },
      ...me
    })
    const moved = await $fetch<{ fields: { parent: Array<{ id: string }> } }>(`/api/records/entries/task/${card.id}`, me)
    expect(moved.fields.parent.map(p => p.id)).toEqual([b.id])
  })

  it('a record of another type opens as a board of the tasks nested under it', async () => {
    const { org, auth } = await createViewsOrgWith(sql)
    const me = withOrgHeader(auth, org.slug)
    await $fetch('/api/records/schema/types', {
      method: 'POST',
      body: { typeKey: 'test_deliverable', label: 'Deliverables', labelSingular: 'Deliverable' },
      ...me
    })
    await $fetch('/api/records/schema/types/test_deliverable/fields', {
      method: 'POST',
      body: { fieldKey: 'work', kind: 'connection', label: 'Work', target: 'task', nesting: 'children' },
      ...me
    })
    const big = await $fetch<{ id: string }>('/api/records/entries/test_deliverable', {
      method: 'POST', body: { fields: { name: 'test-views Big deliverable' } }, ...me
    })
    const api = await createTask(me, { name: 'test-views API', test_deliverable: [big.id] })
    await createTask(me, { name: 'test-views Endpoints', parent: [api.id], status: 'done' })

    const top = await $fetch<Detail & { recordTypeKey: string }>(`/api/views/builtin.subtasks.${big.id}`, me)
    expect(top).toMatchObject({ name: 'test-views Big deliverable', recordTypeKey: 'task', recordId: big.id, recordType: 'test_deliverable', trail: [] })
    expect(await feed(me, top.id, top.tabs[0]!.id)).toEqual(['test-views API'])
    expect(await feed(me, top.id, top.tabs[1]!.id)).toEqual(['test-views API', 'test-views Endpoints'])

    // The task's own board names the deliverable above it.
    const inner = await $fetch<Detail>(`/api/views/builtin.subtasks.${api.id}`, me)
    expect(inner.trail).toEqual([{ id: `builtin.subtasks.${big.id}`, name: 'test-views Big deliverable' }])

    // A view of the deliverables shows each one's progress through its tasks.
    const view = await $fetch<Detail>('/api/views', {
      method: 'POST',
      body: {
        name: 'test-views Deliverables',
        recordTypeKey: 'test_deliverable',
        tab: { layout: 'kanban', definition: { groupField: 'status', cardFields: ['status', 'work'], cardConnections: { work: 'progress' } } }
      },
      ...me
    })
    const cards = await $fetch<Feed>(`/api/views/${view.id}/records`, me)
    expect(cards.items[0]!.progress).toEqual({ work: { total: 1, done: 0 } })
  })

  it('a copy keeps showing what sits under the task', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const project = await createTask(me, { name: 'test-views Project' })
    const child = await createTask(me, { name: 'test-views Child', parent: [project.id] })
    await createTask(me, { name: 'test-views Grandchild', parent: [child.id] })

    const copy = await $fetch<Detail>(`/api/views/builtin.subtasks.${project.id}/copy`, { method: 'POST', body: {}, ...me })
    expect(copy.builtIn).toBe(false)
    expect(await feed(me, copy.id, copy.tabs[0]!.id)).toEqual(['test-views Child'])
    expect(await feed(me, copy.id, copy.tabs[1]!.id)).toEqual(['test-views Child', 'test-views Grandchild'])
  })
})
