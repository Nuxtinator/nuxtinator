// Tabs past the board cap and the guards around a card's shared order: a
// board with too many cards sends none and asks for a filter, a list pages
// with its hand-placed rows first, `position` is no field key or saved sort,
// a copy of a card's board keeps the card's sort but not its order, and a
// connected app reorders only with records.write.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, url as nuxtUrl } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  withOrgHeader,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Feed {
  items: Array<{ id: string, name: string }>
  total: number
  truncated: boolean
  tooMany?: boolean
}

interface Detail {
  id: string
  tabs: Array<{ id: string, layout: string, definition: { sort?: { field: string, dir: string } } }>
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })
}

async function createView(opts: Opts, tab: Record<string, unknown>): Promise<Detail> {
  return await $fetch<Detail>('/api/views', { method: 'POST', body: { name: 'test-views big', recordTypeKey: 'task', tab }, ...opts })
}

function feed(opts: Opts, viewId: string, query: Record<string, unknown> = {}) {
  return $fetch<Feed>(`/api/views/${viewId}/records`, { query, ...opts })
}

describe('tabs past the board cap', () => {
  it('a board with too many cards sends none; a list pages through them', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    await sql`
      INSERT INTO records_entries (record_type, name, status, created_by, org_id, created_at)
      SELECT 'task', 'test-views bulk ' || lpad(g::text, 3, '0'), 'open', ${user.id}, ${org.id}, now() + g * interval '1 millisecond'
      FROM generate_series(1, 501) g
    `
    const board = await createView(me, { layout: 'kanban', definition: { groupField: 'status' } })
    const full = await feed(me, board.id)
    expect(full).toMatchObject({ items: [], total: 501, truncated: true, tooMany: true })
    expect((await feed(me, board.id, { q: 'bulk 00' })).tooMany).toBeFalsy()

    const list = await createView(me, { layout: 'list' })
    const first = await feed(me, list.id, { limit: 100, offset: 0 })
    expect(first).toMatchObject({ total: 501, truncated: true })
    expect(first.items).toHaveLength(100)
    expect(first.items[0]!.name).toBe('test-views bulk 001')
    const last = await feed(me, list.id, { limit: 100, offset: 500 })
    expect(last.items.map(i => i.name)).toEqual(['test-views bulk 501'])
    expect(last.truncated).toBe(false)
  })

  it('a list pages with the rows placed by hand first', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const ids: string[] = []
    for (const name of ['test-views a', 'test-views b', 'test-views c']) ids.push((await createTask(me, { name })).id)
    const list = await createView(me, { layout: 'list' })
    await $fetch(`/api/views/${list.id}/move`, {
      method: 'POST',
      body: { tabId: list.tabs[0]!.id, recordId: ids[2], fromColumn: '', toColumn: '', columnOrder: [ids[2], ids[0], ids[1]] },
      ...me
    })
    expect((await feed(me, list.id, { limit: 1, offset: 0 })).items.map(i => i.name)).toEqual(['test-views c'])
    expect((await feed(me, list.id, { limit: 2, offset: 1 })).items.map(i => i.name)).toEqual(['test-views a', 'test-views b'])
  })
})

describe('guards around a card\'s shared order', () => {
  it('position is no field key and no saved sort, and a copy keeps the card\'s sort but not its order', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const admin = withOrgHeader(auth, org.slug)
    const reserved = await $fetch('/api/records/schema/types/task/fields', {
      method: 'POST',
      body: { fieldKey: 'position', kind: 'text', label: 'Position' },
      ...admin
    }).catch(e => e)
    expect(reserved.statusCode).toBe(400)

    const stored = await createView(admin, { layout: 'list' })
    const refused = await $fetch(`/api/views/${stored.id}/tabs/${stored.tabs[0]!.id}`, {
      method: 'PATCH',
      body: { definition: { sort: { field: 'position', dir: 'asc' } } },
      ...admin
    }).catch(e => e)
    expect(refused.statusCode).toBe(400)

    const card = await createTask(admin, { name: 'test-views Feature' })
    const viewId = `builtin.subtasks.${card.id}`
    const [board, all] = (await $fetch<Detail>(`/api/views/${viewId}`, admin)).tabs
    // Picking what the board shows on its own stores nothing.
    expect(await $fetch(`/api/views/${viewId}/tabs/${board!.id}/record-sort`, { method: 'PUT', body: { sort: { field: 'created_at', dir: 'asc' } }, ...admin })).toEqual({})
    expect(await $fetch(`/api/views/${viewId}/tabs/${all!.id}/record-sort`, { method: 'PUT', body: { sort: { field: 'created_at', dir: 'asc' } }, ...admin })).toEqual({})
    await $fetch(`/api/views/${viewId}/tabs/${all!.id}/record-sort`, { method: 'PUT', body: { sort: { field: 'name', dir: 'desc' } }, ...admin })

    const copy = await $fetch<Detail>(`/api/views/${viewId}/copy`, { method: 'POST', body: {}, ...admin })
    expect(copy.tabs[0]!.definition.sort).toBeUndefined()
    expect(copy.tabs[1]!.definition.sort).toEqual({ field: 'name', dir: 'desc' })
  })

  it('a connected app reorders a card\'s tasks only with records.write', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const card = await createTask(me, { name: 'test-views Feature' })
    const a = await createTask(me, { name: 'test-views a', parent: [card.id] })
    const b = await createTask(me, { name: 'test-views b', parent: [card.id] })
    const viewId = `builtin.subtasks.${card.id}`
    const board = (await $fetch<Detail>(`/api/views/${viewId}`, me)).tabs[0]!
    const body = { tabId: board.id, recordId: b.id, fromColumn: 'open', toColumn: 'open', columnOrder: [b.id, a.id] }

    const moveAs = (token: string) => fetch(nuxtUrl(`/api/views/${viewId}/move`), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'x-active-org': org.slug, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    const reader = await issueMcpBearer(sql, user.id, ['views.use', 'records.read'])
    expect((await moveAs(reader.token)).status).toBe(403)
    expect((await callMcpTool(reader.token, 'views_get_board', { org: org.slug, view: viewId })).isError).toBeFalsy()

    const writer = await issueMcpBearer(sql, user.id, ['views.use', 'records.read', 'records.write'])
    expect((await moveAs(writer.token)).status).toBe(200)
    expect((await feed(me, viewId, { tab: board.id })).items.map(i => i.name)).toEqual(['test-views b', 'test-views a'])
  })
})
