// Custom-column boards: explicit membership (the feed shows only placed
// records), the one-column-per-card invariant across moves, membership
// add/remove guards, and drag writing view state only — never the record.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Feed {
  items: Array<{ id: string, name: string }>
  placements: Array<{ recordId: string, columnKey: string, rank: string | null }>
}

const COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' }
]

async function createBoard(opts: Opts): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/views', {
    method: 'POST',
    body: {
      name: 'test-views custom board',
      recordTypeKey: 'contacts',
      viewType: 'kanban',
      visibility: 'org',
      definition: { columns: COLUMNS }
    },
    ...opts
  })
}

async function createContact(opts: Opts, name: string): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields: { name, status: 'new' } },
    ...opts
  })
}

async function feed(opts: Opts, viewId: string): Promise<Feed> {
  return await $fetch<Feed>(`/api/views/${viewId}/records`, opts)
}

describe('custom boards', () => {
  it('shows only placed records; add/remove manage membership', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const board = await createBoard(opts)
    const onBoard = await createContact(opts, 'test-views On board')
    const offBoard = await createContact(opts, 'test-views Off board')

    await $fetch(`/api/views/${board.id}/cards`, {
      method: 'POST',
      body: { recordId: onBoard.id, columnKey: 'todo' },
      ...opts
    })

    let res = await feed(opts, board.id)
    expect(res.items.map(i => i.id)).toContain(onBoard.id)
    expect(res.items.map(i => i.id)).not.toContain(offBoard.id)
    expect(res.placements).toHaveLength(1)
    expect(res.placements[0]).toMatchObject({ recordId: onBoard.id, columnKey: 'todo' })

    // Double-add and unknown columns are refused.
    await expect($fetch(`/api/views/${board.id}/cards`, {
      method: 'POST',
      body: { recordId: onBoard.id, columnKey: 'doing' },
      ...opts
    })).rejects.toMatchObject({ statusCode: 400 })
    await expect($fetch(`/api/views/${board.id}/cards`, {
      method: 'POST',
      body: { recordId: offBoard.id, columnKey: 'nope' },
      ...opts
    })).rejects.toMatchObject({ statusCode: 400 })

    await $fetch(`/api/views/${board.id}/cards/${onBoard.id}`, {
      method: 'DELETE',
      ...opts
    })
    res = await feed(opts, board.id)
    expect(res.items).toHaveLength(0)
    expect(res.placements).toHaveLength(0)
  })

  it('moves keep exactly one placement and never touch the record', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const board = await createBoard(opts)
    const rec = await createContact(opts, 'test-views Mover')

    await $fetch(`/api/views/${board.id}/cards`, {
      method: 'POST',
      body: { recordId: rec.id, columnKey: 'todo' },
      ...opts
    })

    await $fetch(`/api/views/${board.id}/move`, {
      method: 'POST',
      body: { recordId: rec.id, fromColumn: 'todo', toColumn: 'doing', columnOrder: [rec.id] },
      ...opts
    })

    const res = await feed(opts, board.id)
    const mine = res.placements.filter(p => p.recordId === rec.id)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ columnKey: 'doing' })
    expect(mine[0]!.rank).toBeTruthy()

    // The record's own fields are untouched by a custom-board drag.
    const detail = await $fetch<{ fields: Record<string, unknown> }>(
      `/api/records/entries/contacts/${rec.id}`, opts)
    expect(detail.fields.status).toBe('new')

    // Moving a record that isn't on the board is refused.
    const stranger = await createContact(opts, 'test-views Stranger')
    await expect($fetch(`/api/views/${board.id}/move`, {
      method: 'POST',
      body: { recordId: stranger.id, fromColumn: null, toColumn: 'todo', columnOrder: [stranger.id] },
      ...opts
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
