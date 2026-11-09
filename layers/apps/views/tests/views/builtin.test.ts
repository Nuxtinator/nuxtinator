// Built-in views: declared in code, opened by everyone who can read their
// record type, changed by nobody. My tasks lists the caller's own tasks; its
// cards still move between status columns and quick-add still works through
// the records routes; copying one makes a view of your own. A parameterized
// built-in (the dev host's `test-item-tasks` fixture) opens for one value its
// resolver accepts, and isn't listed.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  addViewsMember,
  withOrgHeader,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Detail {
  id: string
  name: string
  builtIn: boolean
  accessLevel: string
  definition: { filter?: unknown }
  tabs: Array<{ id: string, name: string, layout: string }>
}

interface Feed {
  items: Array<{ id: string, name: string, status: string | null, groupValues?: string[] }>
}

async function createTask(opts: Opts, fields: Record<string, unknown>, confirmShare = false): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', {
    method: 'POST',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

describe('built-in views', () => {
  it('My tasks is listed and shows the caller\'s open tasks, and a board by status', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)

    const mine = await createTask(me, { name: 'test-views Mine', assignee: user.id })
    const done = await createTask(me, { name: 'test-views Mine done', assignee: user.id, status: 'done' })
    await createTask(me, { name: 'test-views Unassigned' })
    await createTask(me, { name: 'test-views Sam\'s', assignee: sam.user.id }, true)

    const list = await $fetch<{ builtIns: Array<{ id: string, name: string, builtIn: boolean }> }>('/api/views', me)
    expect(list.builtIns).toContainEqual(expect.objectContaining({ id: 'builtin.my-tasks', name: 'My tasks', builtIn: true }))
    expect(list.builtIns.some(v => v.id.startsWith('builtin.test-item-tasks'))).toBe(false)

    const view = await $fetch<Detail>('/api/views/builtin.my-tasks', me)
    expect(view).toMatchObject({ id: 'builtin.my-tasks', builtIn: true, accessLevel: 'view' })
    expect(view.tabs.map(t => t.layout)).toEqual(['list', 'kanban'])

    const open = await $fetch<Feed>('/api/views/builtin.my-tasks/records', me)
    expect(open.items.map(i => i.id)).toEqual([mine.id])
    const board = await $fetch<Feed>(`/api/views/builtin.my-tasks/records?tab=${view.tabs[1]!.id}`, me)
    expect(board.items.map(i => i.id).sort()).toEqual([mine.id, done.id].sort())

    // Same view, Sam's tasks.
    const samOpen = await $fetch<Feed>('/api/views/builtin.my-tasks/records', withOrgHeader(sam.auth, org.slug))
    expect(samOpen.items.map(i => i.name)).toEqual(['test-views Sam\'s'])
  })

  it('moves a card between status columns, but can\'t be changed', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const task = await createTask(me, { name: 'test-views Move me', assignee: user.id })
    const view = await $fetch<Detail>('/api/views/builtin.my-tasks', me)
    const boardTab = view.tabs[1]!.id

    await $fetch('/api/views/builtin.my-tasks/move', {
      method: 'POST',
      body: { tabId: boardTab, recordId: task.id, fromColumn: 'open', toColumn: 'in_progress', columnOrder: [task.id] },
      ...me
    })
    const board = await $fetch<Feed>(`/api/views/builtin.my-tasks/records?tab=${boardTab}`, me)
    expect(board.items.find(i => i.id === task.id)?.status).toBe('in_progress')

    const rename = await $fetch('/api/views/builtin.my-tasks', { method: 'PATCH', body: { name: 'Hacked' }, ...me }).catch(e => e)
    expect(rename.statusCode).toBe(403)
    const tab = await $fetch('/api/views/builtin.my-tasks/tabs', { method: 'POST', body: { layout: 'table' }, ...me }).catch(e => e)
    expect(tab.statusCode).toBe(403)
    const del = await $fetch('/api/views/builtin.my-tasks', { method: 'DELETE', ...me }).catch(e => e)
    expect(del.statusCode).toBe(403)
    const missing = await $fetch('/api/views/builtin.nope', me).catch(e => e)
    expect(missing.statusCode).toBe(404)
  })

  it('copying a built-in makes a private view of your own with its filter and tabs', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const task = await createTask(me, { name: 'test-views Copied', assignee: user.id })

    const copy = await $fetch<Detail>('/api/views/builtin.my-tasks/copy', { method: 'POST', body: {}, ...me })
    expect(copy).toMatchObject({ name: 'Copy of My tasks', builtIn: false, accessLevel: 'owner' })
    expect(copy.tabs.map(t => t.name)).toEqual(['Open', 'Board'])
    const feed = await $fetch<Feed>(`/api/views/${copy.id}/records`, me)
    expect(feed.items.map(i => i.id)).toEqual([task.id])

    // The copy is an ordinary view: its tabs can change.
    await $fetch(`/api/views/${copy.id}/tabs`, { method: 'POST', body: { layout: 'table' }, ...me })
  })

  it('a parameterized built-in opens for a value its resolver accepts', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const item = await $fetch<{ id: string }>('/api/records/entries/item', {
      method: 'POST',
      body: { fields: { name: 'test-views Pizza' } },
      ...me
    })
    const on = await createTask(me, { name: 'test-views On pizza', test_item: item.id })
    await createTask(me, { name: 'test-views Elsewhere' })

    const id = `builtin.test-item-tasks.${item.id}`
    const view = await $fetch<Detail>(`/api/views/${id}`, me)
    expect(view).toMatchObject({ id, name: 'Tasks · test-views Pizza', builtIn: true })
    const feed = await $fetch<Feed>(`/api/views/${id}/records`, me)
    expect(feed.items.map(i => i.id)).toEqual([on.id])

    // Sam can't see the item, so the view doesn't exist for Sam.
    const hidden = await $fetch(`/api/views/${id}`, withOrgHeader(sam.auth, org.slug)).catch(e => e)
    expect(hidden.statusCode).toBe(404)
    // The bare key needs its value.
    const bare = await $fetch('/api/views/builtin.test-item-tasks', me).catch(e => e)
    expect(bare.statusCode).toBe(404)
  })

  it('MCP lists built-ins and reads them', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    await createTask(me, { name: 'test-views Via MCP', assignee: user.id })
    const { token } = await issueMcpBearer(sql, user.id, ['views.use', 'records.read'])

    const listed = await callMcpTool(token, 'views_list', { org: org.slug })
    expect(JSON.stringify(listed)).toContain('builtin.my-tasks')

    const board = await callMcpTool(token, 'views_get_board', { org: org.slug, view: 'builtin.my-tasks' })
    expect(board.isError).toBeFalsy()
    expect(JSON.stringify(board)).toContain('test-views Via MCP')
  })
})
