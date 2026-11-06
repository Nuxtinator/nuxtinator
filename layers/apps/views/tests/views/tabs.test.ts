// Tabs and the filter tree: a view's tabs are added, changed, reordered and
// deleted (never the last); each tab filters with AND/OR groups and "@me";
// lists keep their own manual order and move records between sections; and
// hand-picked views share their records across tabs.
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

interface Tab { id: string, name: string, layout: string, position: string, definition: Record<string, unknown> }
interface View { id: string, definition: Record<string, unknown>, tabs: Tab[] }
interface Feed {
  tabId: string
  items: Array<{ id: string, name: string, status: string | null, createdAt: string, updatedAt: string }>
  placements: Array<{ recordId: string, columnKey: string, rank: string | null }>
}

async function createView(opts: Opts, body: Record<string, unknown>): Promise<View> {
  return await $fetch<View>('/api/views', {
    method: 'POST',
    body: { name: 'test-views tabs', recordTypeKey: 'task', ...body },
    ...opts
  })
}

async function addTab(opts: Opts, viewId: string, body: Record<string, unknown>): Promise<Tab> {
  return await $fetch<Tab>(`/api/views/${viewId}/tabs`, { method: 'POST', body, ...opts })
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })
}

async function feed(opts: Opts, viewId: string, tabId?: string): Promise<Feed> {
  return await $fetch<Feed>(`/api/views/${viewId}/records`, { query: { tab: tabId }, ...opts })
}

async function ids(opts: Opts, viewId: string, tabId?: string): Promise<string[]> {
  return (await feed(opts, viewId, tabId)).items.map(i => i.id).sort()
}

describe('tabs', () => {
  it('are added after the last one, changed, reordered and deleted — never the last', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { tab: { layout: 'list' } })
    expect(view.tabs.map(t => [t.name, t.layout])).toEqual([['List', 'list']])

    const board = await addTab(opts, view.id, { name: 'By status', layout: 'kanban', definition: { groupField: 'status' } })
    const table = await addTab(opts, view.id, { layout: 'table' })
    let detail = await $fetch<View>(`/api/views/${view.id}`, opts)
    expect(detail.tabs.map(t => t.name)).toEqual(['List', 'By status', 'Table'])

    // A layout switch keeps what still applies: a table has no grouping.
    const switched = await $fetch<Tab>(`/api/views/${view.id}/tabs/${board.id}`, {
      method: 'PATCH',
      body: { name: 'Grid', layout: 'table' },
      ...opts
    })
    expect(switched).toMatchObject({ name: 'Grid', layout: 'table', definition: {} })
    // A board can't lose its grouping.
    await expect($fetch(`/api/views/${view.id}/tabs/${table.id}`, { method: 'PATCH', body: { layout: 'kanban' }, ...opts }))
      .rejects.toMatchObject({ statusCode: 400 })

    const reordered = await $fetch<{ tabs: Tab[] }>(`/api/views/${view.id}/tab-order`, {
      method: 'PUT',
      body: { tabIds: [table.id, view.tabs[0]!.id, board.id] },
      ...opts
    })
    expect(reordered.tabs.map(t => t.id)).toEqual([table.id, view.tabs[0]!.id, board.id])
    await expect($fetch(`/api/views/${view.id}/tab-order`, { method: 'PUT', body: { tabIds: [table.id] }, ...opts }))
      .rejects.toMatchObject({ statusCode: 400 })

    // The feed without a tab is the first tab's.
    expect((await feed(opts, view.id)).tabId).toBe(table.id)

    await $fetch(`/api/views/${view.id}/tabs/${table.id}`, { method: 'DELETE', ...opts })
    await $fetch(`/api/views/${view.id}/tabs/${board.id}`, { method: 'DELETE', ...opts })
    await expect($fetch(`/api/views/${view.id}/tabs/${view.tabs[0]!.id}`, { method: 'DELETE', ...opts }))
      .rejects.toMatchObject({ statusCode: 409 })
    detail = await $fetch<View>(`/api/views/${view.id}`, opts)
    expect(detail.tabs.map(t => t.id)).toEqual([view.tabs[0]!.id])
  })

  it('serve camelCase timestamps on every layout', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createTask(opts, { name: 'test-views Dated' })
    const view = await createView(opts, { tab: { layout: 'kanban', definition: { groupField: 'status' } } })
    const table = await addTab(opts, view.id, { layout: 'table' })

    for (const tabId of [view.tabs[0]!.id, table.id]) {
      const item = (await feed(opts, view.id, tabId)).items.find(i => i.name === 'test-views Dated')!
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false)
      expect(Number.isNaN(Date.parse(item.updatedAt))).toBe(false)
    }
  })
})

describe('the filter tree', () => {
  it('combines rules with all/any, one group deep, and "@me" means whoever is looking', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const colleague = await addViewsMember(sql, org.id, ['admin'])
    const colleagueOpts = withOrgHeader(colleague.auth, org.slug)

    const mine = await createTask(opts, { name: 'test-views Mine', assignee: user.id })
    const theirs = await createTask(opts, { name: 'test-views Theirs', assignee: colleague.user.id })
    const nobody = await createTask(opts, { name: 'test-views Nobody' })
    const done = await createTask(opts, { name: 'test-views Done mine', assignee: user.id, status: 'done' })

    // My open tasks, plus anything unassigned.
    const view = await createView(opts, {
      visibility: 'org',
      tab: {
        layout: 'list',
        definition: {
          filter: {
            match: 'all',
            rules: [
              { field: 'status', op: 'is', value: 'open' },
              { match: 'any', rules: [{ field: 'assignee', op: 'is', value: '@me' }, { field: 'assignee', op: 'empty' }] }
            ]
          }
        }
      }
    })
    const scope = [mine.id, theirs.id, nobody.id, done.id]
    const seen = async (o: Opts) => (await ids(o, view.id)).filter(id => scope.includes(id))
    expect(await seen(opts)).toEqual([mine.id, nobody.id].sort())
    // The same tab, opened by a colleague, shows their tasks instead.
    expect(await seen(colleagueOpts)).toEqual([theirs.id, nobody.id].sort())
  })

  it('compares dates by day, keeps empty values in "none of", and matches every tag for "all of"', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const early = await createTask(opts, { name: 'test-views Early', due_date: '2026-11-02' })
    const late = await createTask(opts, { name: 'test-views Late', due_date: '2026-11-20' })
    const undated = await createTask(opts, { name: 'test-views Undated', status: 'done' })
    const view = await createView(opts, { tab: { layout: 'table' } })
    const scope = [early.id, late.id, undated.id]

    const withFilter = async (filter: unknown) => {
      await $fetch(`/api/views/${view.id}/tabs/${view.tabs[0]!.id}`, { method: 'PATCH', body: { definition: { filter } }, ...opts })
      return (await ids(opts, view.id)).filter(id => scope.includes(id))
    }
    expect(await withFilter({ match: 'all', rules: [{ field: 'due_date', op: 'before', value: '2026-11-10' }] })).toEqual([early.id])
    expect(await withFilter({ match: 'all', rules: [{ field: 'due_date', op: 'on', value: '2026-11-20' }] })).toEqual([late.id])
    expect(await withFilter({ match: 'all', rules: [{ field: 'due_date', op: 'between', value: ['2026-11-01', '2026-11-30'] }] }))
      .toEqual([early.id, late.id].sort())
    expect(await withFilter({ match: 'all', rules: [{ field: 'due_date', op: 'empty' }] })).toEqual([undated.id])
    expect(await withFilter({ match: 'all', rules: [{ field: 'status', op: 'none_of', value: ['done'] }] }))
      .toEqual([early.id, late.id].sort())
    expect(await withFilter({ match: 'any', rules: [{ field: 'name', op: 'contains', value: 'early' }, { field: 'status', op: 'is', value: 'done' }] }))
      .toEqual([early.id, undated.id].sort())

    const tagged = await $fetch<{ id: string }>('/api/records/entries/item', {
      method: 'POST',
      body: { fields: { name: 'test-views Pizza', tags: ['ideas', 'tried'] } },
      ...opts
    })
    const half = await $fetch<{ id: string }>('/api/records/entries/item', {
      method: 'POST',
      body: { fields: { name: 'test-views Bread', tags: ['ideas'] } },
      ...opts
    })
    const items = await createView(opts, {
      recordTypeKey: 'item',
      tab: { layout: 'list', definition: { filter: { match: 'all', rules: [{ field: 'tags', op: 'all_of', value: ['ideas', 'tried'] }] } } }
    })
    expect((await ids(opts, items.id)).filter(id => [tagged.id, half.id].includes(id))).toEqual([tagged.id])
  })
})

describe('lists', () => {
  it('an ungrouped list keeps its own manual order, separate from other tabs', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const a = await createTask(opts, { name: 'test-views A' })
    const b = await createTask(opts, { name: 'test-views B' })
    const view = await createView(opts, { tab: { layout: 'list' } })
    const other = await addTab(opts, view.id, { layout: 'list' })

    await $fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { tabId: view.tabs[0]!.id, recordId: b.id, fromColumn: '', toColumn: '', columnOrder: [b.id, a.id] },
      ...opts
    })
    const ranked = (await feed(opts, view.id)).placements
      .filter(p => [a.id, b.id].includes(p.recordId))
      .sort((x, y) => x.rank! < y.rank! ? -1 : 1)
    expect(ranked.map(p => [p.recordId, p.columnKey])).toEqual([[b.id, ''], [a.id, '']])
    expect((await feed(opts, view.id, other.id)).placements).toEqual([])

    // An ungrouped list has no sections to move into.
    await expect($fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { tabId: view.tabs[0]!.id, recordId: a.id, fromColumn: '', toColumn: 'done', columnOrder: [a.id] },
      ...opts
    })).rejects.toMatchObject({ statusCode: 400 })
    // Tables are sorted, not ordered by hand.
    const table = await addTab(opts, view.id, { layout: 'table' })
    await expect($fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { tabId: table.id, recordId: a.id, fromColumn: '', toColumn: '', columnOrder: [a.id] },
      ...opts
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a list grouped by status moves a task into another section', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const task = await createTask(opts, { name: 'test-views Section mover' })
    const view = await createView(opts, { tab: { layout: 'list', definition: { groupField: 'status' } } })

    await $fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { recordId: task.id, fromColumn: 'open', toColumn: 'done', columnOrder: [task.id] },
      ...opts
    })
    const detail = await $fetch<{ status: string }>(`/api/records/entries/task/${task.id}`, opts)
    expect(detail.status).toBe('done')
  })

  it('a task created without a status reads as the type default', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const plain = await createTask(opts, { name: 'test-views Defaulted' })
    const blank = await createTask(opts, { name: 'test-views Blank', status: null })
    expect((await $fetch<{ status: string | null }>(`/api/records/entries/task/${plain.id}`, opts)).status).toBe('open')
    expect((await $fetch<{ status: string | null }>(`/api/records/entries/task/${blank.id}`, opts)).status).toBe('open')
  })
})

describe('hand-picked views', () => {
  it('share their records across tabs; removing one takes it off every tab', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, {
      recordTypeKey: 'item',
      definition: { picked: true },
      tab: { layout: 'kanban', definition: { columns: [{ key: 'ideas', label: 'Ideas' }, { key: 'tried', label: 'Tried' }] } }
    })
    const list = await addTab(opts, view.id, { layout: 'list' })
    const pizza = await $fetch<{ id: string }>('/api/records/entries/item', {
      method: 'POST',
      body: { fields: { name: 'test-views Pizza' } },
      ...opts
    })
    const elsewhere = await $fetch<{ id: string }>('/api/records/entries/item', {
      method: 'POST',
      body: { fields: { name: 'test-views Not picked' } },
      ...opts
    })

    // Added from the list tab: it lands at the end of that list, and the
    // board shows it in its first column.
    await $fetch(`/api/views/${view.id}/cards`, { method: 'POST', body: { recordId: pizza.id, tabId: list.id }, ...opts })
    expect(await ids(opts, view.id, list.id)).toEqual([pizza.id])
    const board = await feed(opts, view.id, view.tabs[0]!.id)
    expect(board.items.map(i => i.id)).toEqual([pizza.id])
    expect(board.placements).toEqual([])
    expect((await feed(opts, view.id, list.id)).placements).toMatchObject([{ recordId: pizza.id, columnKey: '' }])

    // A board move works for a record placed only by the fallback.
    await $fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { recordId: pizza.id, fromColumn: 'ideas', toColumn: 'tried', columnOrder: [pizza.id] },
      ...opts
    })
    expect((await feed(opts, view.id)).placements).toMatchObject([{ recordId: pizza.id, columnKey: 'tried' }])
    await expect($fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { recordId: elsewhere.id, fromColumn: 'ideas', toColumn: 'tried', columnOrder: [elsewhere.id] },
      ...opts
    })).rejects.toMatchObject({ statusCode: 400 })

    await $fetch(`/api/views/${view.id}/cards/${pizza.id}`, { method: 'DELETE', ...opts })
    expect(await ids(opts, view.id, list.id)).toEqual([])
    expect((await feed(opts, view.id)).placements).toEqual([])

    // Views that show every matching record have nothing to add.
    const all = await createView(opts, { recordTypeKey: 'item', tab: { layout: 'list' } })
    await expect($fetch(`/api/views/${all.id}/cards`, { method: 'POST', body: { recordId: pizza.id }, ...opts }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})
