// The sort of a card's board: each card keeps its own, everyone who opens
// that board sees it, only people who can edit the card change it, and it
// goes with the card. Stored views have no sort of this kind.
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
type Sort = { field: string, dir: 'asc' | 'desc' }

interface Detail {
  id: string
  canOrder: boolean
  tabs: Array<{ id: string, recordSort?: Sort | null }>
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })
}

async function feature(opts: Opts, name: string, tasks: string[]): Promise<string> {
  const card = await createTask(opts, { name })
  for (const task of tasks) await createTask(opts, { name: task, parent: [card.id] })
  return card.id
}

async function names(opts: Opts, viewId: string, tabId: string): Promise<string[]> {
  const res = await $fetch<{ items: Array<{ name: string }> }>(`/api/views/${viewId}/records`, { query: { tab: tabId }, ...opts })
  return res.items.map(i => i.name)
}

function setSort(opts: Opts, viewId: string, tabId: string, sort: Sort | null) {
  return $fetch(`/api/views/${viewId}/tabs/${tabId}/record-sort`, { method: 'PUT', body: { sort }, ...opts })
}

describe('the sort of a card\'s board', () => {
  it('belongs to the card: everyone sees it, other cards keep theirs', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const one = await feature(owner, 'test-views Feature 1', ['test-views b', 'test-views a'])
    const two = await feature(owner, 'test-views Feature 2', ['test-views y', 'test-views x'])
    await $fetch(`/api/records/entries/task/${one}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })

    const first = `builtin.subtasks.${one}`
    const second = `builtin.subtasks.${two}`
    const board = (await $fetch<Detail>(`/api/views/${first}`, owner)).tabs[0]!
    expect(board.recordSort).toBeNull()

    expect(await setSort(owner, first, board.id, { field: 'name', dir: 'asc' })).toEqual({ sort: { field: 'name', dir: 'asc' } })
    expect(await names(owner, first, board.id)).toEqual(['test-views a', 'test-views b'])
    expect(await names(samOpts, first, board.id)).toEqual(['test-views a', 'test-views b'])
    expect((await $fetch<Detail>(`/api/views/${first}`, samOpts)).tabs[0]!.recordSort).toEqual({ field: 'name', dir: 'asc' })

    expect((await $fetch<Detail>(`/api/views/${second}`, owner)).tabs[0]!.recordSort).toBeNull()
    expect(await names(owner, second, board.id)).toEqual(['test-views y', 'test-views x'])

    expect(await setSort(owner, first, board.id, null)).toEqual({})
    expect(await names(owner, first, board.id)).toEqual(['test-views b', 'test-views a'])
  })

  it('only people who can edit the card change it, and Manual stays on the board that has it', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const reader = await createViewsRole(sql, org.id, ['views.use', 'records.access', 'records.entries.read', 'records.read'])
    const sam = await addViewsMember(sql, org.id, [reader])
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const one = await feature(owner, 'test-views Feature 1', ['test-views a'])
    await $fetch(`/api/records/entries/task/${one}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...owner })

    const viewId = `builtin.subtasks.${one}`
    const [board, all] = (await $fetch<Detail>(`/api/views/${viewId}`, owner)).tabs
    expect((await $fetch<Detail>(`/api/views/${viewId}`, samOpts)).canOrder).toBe(false)
    expect((await setSort(samOpts, viewId, board!.id, { field: 'name', dir: 'asc' }).catch(e => e)).statusCode).toBe(403)
    expect((await setSort(owner, viewId, all!.id, { field: 'position', dir: 'asc' }).catch(e => e)).statusCode).toBe(400)
    expect((await setSort(owner, viewId, board!.id, { field: 'nope', dir: 'asc' }).catch(e => e)).statusCode).toBe(400)
    expect(await setSort(owner, viewId, all!.id, { field: 'name', dir: 'desc' })).toEqual({ sort: { field: 'name', dir: 'desc' } })
  })

  it('goes with the card, and a stored view has none', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const me = withOrgHeader(auth, org.slug)
    const one = await feature(me, 'test-views Feature 1', ['test-views a'])
    const viewId = `builtin.subtasks.${one}`
    const board = (await $fetch<Detail>(`/api/views/${viewId}`, me)).tabs[0]!
    await setSort(me, viewId, board.id, { field: 'name', dir: 'asc' })

    await $fetch(`/api/records/entries/task/${one}`, { method: 'DELETE', ...me })
    const [{ count }] = await sql<[{ count: number }]>`select count(*)::int as count from views_record_tabs where record_id = ${one}`
    expect(count).toBe(0)

    const created = await $fetch<Detail>('/api/views', {
      method: 'POST',
      body: { name: 'test-views board', recordTypeKey: 'task', tab: { layout: 'kanban', definition: { groupField: 'status' } } },
      ...me
    })
    const stored = await $fetch<Detail>(`/api/views/${created.id}`, me)
    expect(stored.canOrder).toBe(false)
    expect((await setSort(me, stored.id, stored.tabs[0]!.id, { field: 'name', dir: 'asc' }).catch(e => e)).statusCode).toBe(400)
  })
})
