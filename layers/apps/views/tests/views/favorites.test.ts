// A person's favorite cards and card boards: each person keeps their own; a
// card opens on the view it was added from until that view is out of reach;
// records the person can't see aren't listed; and a favorite goes with its
// record.
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

interface Favorite {
  kind: 'card' | 'board'
  recordId: string
  name: string
  recordType: string
  viewId: string | null
  viewName: string | null
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })
}

async function createView(opts: Opts, name: string, body: Record<string, unknown> = {}): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/views', {
    method: 'POST',
    body: { name, recordTypeKey: 'task', tab: { layout: 'kanban', definition: { groupField: 'status' } }, ...body },
    ...opts
  })
}

function favorite(opts: Opts, kind: string, recordId: string, viewId?: string) {
  return $fetch<Favorite>(`/api/views/favorites/${kind}/${recordId}`, { method: 'PUT', body: viewId ? { viewId } : {}, ...opts })
}

function unfavorite(opts: Opts, kind: string, recordId: string) {
  return $fetch(`/api/views/favorites/${kind}/${recordId}`, { method: 'DELETE', ...opts })
}

async function favorites(opts: Opts): Promise<Favorite[]> {
  return (await $fetch<{ items: Favorite[] }>('/api/views/favorites', opts)).items
}

describe('favorites', () => {
  it('keeps a card on its view and a card board, oldest first, for their person only', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const feature = await createTask(me, { name: 'test-views Feature' })
    const task = await createTask(me, { name: 'test-views Task', parent: [feature.id] })
    const board = await createView(me, 'test-views Sprint')

    expect(await favorite(me, 'card', task.id, board.id)).toEqual({
      kind: 'card', recordId: task.id, name: 'test-views Task', recordType: 'task', viewId: board.id, viewName: 'test-views Sprint'
    })
    expect(await favorite(me, 'board', feature.id)).toMatchObject({ kind: 'board', recordId: feature.id, viewId: null })
    const onBoard = `builtin.subtasks.${feature.id}`
    await favorite(me, 'card', feature.id, onBoard)

    expect((await favorites(me)).map(f => [f.kind, f.name, f.viewName])).toEqual([
      ['card', 'test-views Task', 'test-views Sprint'],
      ['board', 'test-views Feature', null],
      ['card', 'test-views Feature', 'test-views Feature']
    ])
    expect(await favorites(samOpts)).toEqual([])

    // Adding a card again points it at the view it's added from now, in its place.
    await favorite(me, 'card', task.id, 'builtin.my-tasks')
    expect((await favorites(me))[0]).toMatchObject({ recordId: task.id, viewId: 'builtin.my-tasks', viewName: 'My tasks' })

    expect(await unfavorite(me, 'board', feature.id)).toEqual({ ok: true })
    expect(await unfavorite(me, 'board', feature.id)).toEqual({ ok: true })
    expect((await favorites(me)).map(f => `${f.kind}:${f.recordId}`)).toEqual([`card:${task.id}`, `card:${feature.id}`])
  })

  it('opens a card as its record once its view is out of reach, and hides records out of sight', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const task = await createTask(me, { name: 'test-views Shared task' })
    const view = await createView(me, 'test-views Shared board')
    await $fetch(`/api/records/entries/task/${task.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...me })
    await $fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: sam.user.id, level: 'view' }, ...me })

    await favorite(samOpts, 'card', task.id, view.id)
    await favorite(samOpts, 'board', task.id)

    await $fetch(`/api/views/${view.id}`, { method: 'DELETE', ...me })
    expect(await favorites(samOpts)).toEqual([
      { kind: 'card', recordId: task.id, name: 'test-views Shared task', recordType: 'task', viewId: null, viewName: null },
      { kind: 'board', recordId: task.id, name: 'test-views Shared task', recordType: 'task', viewId: null, viewName: null }
    ])

    await $fetch(`/api/records/entries/task/${task.id}/shares/${sam.user.id}`, { method: 'DELETE', ...me })
    expect(await favorites(samOpts)).toEqual([])

    await $fetch(`/api/records/entries/task/${task.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...me })
    expect(await favorites(samOpts)).toHaveLength(2)

    await sql`delete from records_entries where id = ${task.id}`
    const [{ count }] = await sql<[{ count: number }]>`select count(*)::int as count from views_favorites where record_id = ${task.id}`
    expect(count).toBe(0)
  })

  it('refuses records, views and boards the person can\'t open, and malformed favorites', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const me = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const mine = await createTask(me, { name: 'test-views Private task' })
    const privateView = await createView(me, 'test-views Private board')
    const shared = await createTask(me, { name: 'test-views Shared task' })
    await $fetch(`/api/records/entries/task/${shared.id}/shares`, { method: 'POST', body: { userId: sam.user.id }, ...me })

    const status = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode: number }) => e.statusCode)
    expect(await status(favorite(samOpts, 'card', mine.id, 'builtin.my-tasks'))).toBe(404)
    expect(await status(favorite(samOpts, 'board', mine.id))).toBe(404)
    expect(await status(favorite(samOpts, 'card', shared.id, privateView.id))).toBe(404)
    expect(await status(favorite(samOpts, 'card', shared.id))).toBe(400)
    expect(await status(favorite(samOpts, 'board', shared.id, 'builtin.my-tasks'))).toBe(400)
    expect(await status(favorite(samOpts, 'pin', shared.id))).toBe(400)
    expect(await status(favorite(samOpts, 'card', 'not-a-uuid', 'builtin.my-tasks'))).toBe(400)
    expect(await status(favorite(samOpts, 'card', shared.id, 'nope'))).toBe(400)
    expect(await favorites(samOpts)).toEqual([])
  })
})
