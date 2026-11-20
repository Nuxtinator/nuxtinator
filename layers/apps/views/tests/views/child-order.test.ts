// The order of a card's tasks: one order everyone sees, set by dragging on
// the card's board by people who can edit the card, followed by the card's
// own task list; a task moved to another card loses its place. Boards and
// lists with no sort show the oldest cards first.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  createViewsRole,
  addViewsMember,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Detail {
  id: string
  canOrder: boolean
  tabs: Array<{ id: string, definition: { sort?: { field: string } } }>
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })
}

async function names(opts: Opts, viewId: string, tabId?: string): Promise<string[]> {
  const res = await $fetch<{ items: Array<{ name: string }> }>(`/api/views/${viewId}/records`, { query: { tab: tabId }, ...opts })
  return res.items.map(i => i.name)
}

async function childNames(opts: Opts, parentId: string): Promise<string[]> {
  const res = await $fetch<{ items: Array<{ name: string }> }>('/api/records/entries/task', {
    query: { filters: JSON.stringify({ parent: parentId }), sort: 'position' },
    ...opts
  })
  return res.items.map(i => i.name)
}

function move(opts: Opts, viewId: string, body: Record<string, unknown>) {
  return $fetch(`/api/views/${viewId}/move`, { method: 'POST', body, ...opts })
}

async function feature(opts: Opts, name: string, tasks: string[]) {
  const card = await createTask(opts, { name })
  const ids: Record<string, string> = {}
  for (const task of tasks) ids[task] = (await createTask(opts, { name: task, parent: [card.id] })).id
  return { card, ids }
}

describe('the order of a card\'s tasks', () => {
  it('is one order: dragging on the card\'s board changes it for everyone and the card\'s task list', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const { card, ids } = await feature(owner, 'test-views Feature', ['test-views a', 'test-views b', 'test-views c'])
    await $fetch(`/api/records/entries/task/${card.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })

    const viewId = `builtin.subtasks.${card.id}`
    const view = await $fetch<Detail>(`/api/views/${viewId}`, owner)
    const board = view.tabs[0]!
    expect(board.definition.sort?.field).toBe('position')
    expect(view.canOrder).toBe(true)
    expect(await names(owner, viewId, board.id)).toEqual(['test-views a', 'test-views b', 'test-views c'])
    const ordered = async () => (await $fetch<{ ordered?: boolean }>(`/api/views/${viewId}/records`, { query: { tab: board.id }, ...owner })).ordered
    expect(await ordered()).toBe(false)

    const c = ids['test-views c']!
    await move(owner, viewId, { tabId: board.id, recordId: c, fromColumn: 'open', toColumn: 'open', columnOrder: [c, ids['test-views a'], ids['test-views b']] })
    expect(await ordered()).toBe(true)
    expect(await names(owner, viewId, board.id)).toEqual(['test-views c', 'test-views a', 'test-views b'])
    expect(await names(samOpts, viewId, board.id)).toEqual(['test-views c', 'test-views a', 'test-views b'])
    expect(await childNames(owner, card.id)).toEqual(['test-views c', 'test-views a', 'test-views b'])

    // A card dropped into another column lands where it was dropped.
    const a = ids['test-views a']!
    await move(owner, viewId, { tabId: board.id, recordId: c, fromColumn: 'open', toColumn: 'in_progress', columnOrder: [c] })
    await move(owner, viewId, { tabId: board.id, recordId: a, fromColumn: 'open', toColumn: 'in_progress', columnOrder: [c, a] })
    expect(await names(owner, viewId, board.id)).toEqual(['test-views c', 'test-views a', 'test-views b'])
    await move(owner, viewId, { tabId: board.id, recordId: a, fromColumn: 'in_progress', toColumn: 'in_progress', columnOrder: [a, c] })
    expect(await names(owner, viewId, board.id)).toEqual(['test-views a', 'test-views c', 'test-views b'])
  })

  it('only people who can edit the card change it', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const reader = await createViewsRole(sql, org.id, ['views.use', 'records.access', 'records.entries.read', 'records.read'])
    const sam = await addViewsMember(sql, org.id, [reader])
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const { card, ids } = await feature(owner, 'test-views Feature', ['test-views a', 'test-views b'])
    await $fetch(`/api/records/entries/task/${card.id}/shares`, { method: 'POST', body: { userId: sam.user.id, level: 'view' }, ...owner })

    const viewId = `builtin.subtasks.${card.id}`
    const view = await $fetch<Detail>(`/api/views/${viewId}`, samOpts)
    expect(view.canOrder).toBe(false)
    const b = ids['test-views b']!
    const refused = await move(samOpts, viewId, { tabId: view.tabs[0]!.id, recordId: b, fromColumn: 'open', toColumn: 'open', columnOrder: [b, ids['test-views a']] }).catch(e => e)
    expect(refused.statusCode).toBe(403)
    expect(await names(owner, viewId, view.tabs[0]!.id)).toEqual(['test-views a', 'test-views b'])
  })

  it('a board sorted another way doesn\'t reorder, and a task moved to another card loses its place', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const { card, ids } = await feature(me, 'test-views Feature', ['test-views a', 'test-views b'])
    const other = await createTask(me, { name: 'test-views Other feature' })
    const viewId = `builtin.subtasks.${card.id}`
    const board = (await $fetch<Detail>(`/api/views/${viewId}`, me)).tabs[0]!
    const b = ids['test-views b']!
    await move(me, viewId, { tabId: board.id, recordId: b, fromColumn: 'open', toColumn: 'open', columnOrder: [b, ids['test-views a']] })

    await $fetch(`/api/views/${viewId}/tabs/${board.id}/record-sort`, { method: 'PUT', body: { sort: { field: 'name', dir: 'asc' } }, ...me })
    const refused = await move(me, viewId, { tabId: board.id, recordId: ids['test-views a']!, fromColumn: 'open', toColumn: 'open', columnOrder: [ids['test-views a'], b] }).catch(e => e)
    expect(refused.statusCode).toBe(403)

    await $fetch(`/api/records/entries/task/${b}`, { method: 'PATCH', body: { fields: { parent: [other.id] } }, ...me })
    const [row] = await sql<[{ position: string | null }]>`select position from records_entries where id = ${b}`
    expect(row.position).toBeNull()
  })

  it('boards and lists with no sort show the oldest cards first', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const first = await createTask(me, { name: 'test-views first' })
    await createTask(me, { name: 'test-views second' })
    await createTask(me, { name: 'test-views third' })
    await $fetch(`/api/records/entries/task/${first.id}`, { method: 'PATCH', body: { fields: { name: 'test-views first edited' } }, ...me })

    const view = await $fetch<{ id: string }>('/api/views', {
      method: 'POST',
      body: { name: 'test-views board', recordTypeKey: 'task', tab: { layout: 'kanban', definition: { groupField: 'status' } } },
      ...me
    })
    expect((await names(me, view.id)).filter(n => n.startsWith('test-views'))).toEqual(['test-views first edited', 'test-views second', 'test-views third'])
  })
})
