// The order of the columns of field-grouped boards and lists: one per view
// and grouping field, shared by every tab grouped by it, changed by people
// who can edit the view. A card's board keeps its order on the card. Only
// placed columns are stored, and copying a view copies the order.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  createViewsRole,
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
  columnOrder: Record<string, Record<string, string>>
  tabs: Array<{ id: string }>
}

async function createStatusView(opts: Opts): Promise<Detail> {
  const view = await $fetch<Detail>('/api/views', {
    method: 'POST',
    body: {
      name: 'test-views By status',
      recordTypeKey: 'task',
      visibility: 'org',
      tab: { layout: 'kanban', definition: { groupField: 'status' } }
    },
    ...opts
  })
  await $fetch(`/api/views/${view.id}/tabs`, { method: 'POST', body: { layout: 'list', definition: { groupField: 'status' } }, ...opts })
  return view
}

function place(opts: Opts, viewId: string, body: { field: string, key: string, order: string[] }) {
  return $fetch<{ field: string, positions: Record<string, string> }>(`/api/views/${viewId}/column-order`, { method: 'PUT', body, ...opts })
}

function inOrder(positions: Record<string, string> | undefined): string[] {
  return Object.entries(positions ?? {}).sort(([, a], [, b]) => a < b ? -1 : a > b ? 1 : 0).map(([key]) => key)
}

describe('column order', () => {
  it('is kept per view and field, and a drag between placed columns writes only that column', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await createStatusView(owner)
    const other = await createStatusView(owner)
    expect(view.columnOrder).toEqual({})

    // Neighbours nobody placed: every listed column is placed, in that order.
    const first = await place(owner, view.id, { field: 'status', key: 'done', order: ['done', 'open', 'in_progress'] })
    expect(inOrder(first.positions)).toEqual(['done', 'open', 'in_progress'])

    const second = await place(owner, view.id, { field: 'status', key: 'in_progress', order: ['done', 'in_progress', 'open'] })
    expect(inOrder(second.positions)).toEqual(['done', 'in_progress', 'open'])
    expect(second.positions.done).toBe(first.positions.done)
    expect(second.positions.open).toBe(first.positions.open)

    const detail = await $fetch<Detail>(`/api/views/${view.id}`, owner)
    expect(detail.tabs).toHaveLength(2)
    expect(inOrder(detail.columnOrder.status)).toEqual(['done', 'in_progress', 'open'])
    expect((await $fetch<Detail>(`/api/views/${other.id}`, owner)).columnOrder).toEqual({})
  })

  it('needs edit access to the view', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const view = await createStatusView(owner)

    const refused = await place(withOrgHeader(sam.auth, org.slug), view.id, { field: 'status', key: 'done', order: ['done', 'open', 'in_progress'] }).catch(e => e)
    expect(refused.statusCode).toBe(403)
    expect((await $fetch<Detail>(`/api/views/${view.id}`, owner)).columnOrder).toEqual({})

    await $fetch(`/api/views/${view.id}`, { method: 'PATCH', body: { visibility: 'org', orgLevel: 'edit' }, ...owner })
    await place(withOrgHeader(sam.auth, org.slug), view.id, { field: 'status', key: 'done', order: ['done', 'open', 'in_progress'] })
    expect(inOrder((await $fetch<Detail>(`/api/views/${view.id}`, owner)).columnOrder.status)).toEqual(['done', 'open', 'in_progress'])
  })

  it('takes only a field one of its tabs groups by, and keeps "No value" first', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await createStatusView(owner)

    const ungrouped = await place(owner, view.id, { field: 'priority', key: 'high', order: ['high', 'low'] }).catch(e => e)
    expect(ungrouped.statusCode).toBe(400)
    const noValue = await place(owner, view.id, { field: 'status', key: '', order: ['', 'open'] }).catch(e => e)
    expect(noValue.statusCode).toBe(400)
    const missing = await place(owner, view.id, { field: 'status', key: 'done', order: ['open'] }).catch(e => e)
    expect(missing.statusCode).toBe(400)
  })

  it('comes along when the view is copied', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await createStatusView(owner)
    await place(owner, view.id, { field: 'status', key: 'done', order: ['done', 'in_progress', 'open'] })

    const copy = await $fetch<Detail>(`/api/views/${view.id}/copy`, { method: 'POST', body: {}, ...owner })
    expect(inOrder(copy.columnOrder.status)).toEqual(['done', 'in_progress', 'open'])
    await place(owner, copy.id, { field: 'status', key: 'open', order: ['open', 'done', 'in_progress'] })
    expect(inOrder((await $fetch<Detail>(`/api/views/${view.id}`, owner)).columnOrder.status)).toEqual(['done', 'in_progress', 'open'])
  })

  it('on a card\'s board is the card\'s, changed by people who can edit it', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const reader = await createViewsRole(sql, org.id, ['views.use', 'records.access', 'records.entries.read', 'records.read'])
    const sam = await addViewsMember(sql, org.id, [reader])
    const samOpts = withOrgHeader(sam.auth, org.slug)
    const card = await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields: { name: 'test-views Feature' } }, ...owner })
    const otherCard = await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields: { name: 'test-views Other' } }, ...owner })
    await $fetch(`/api/records/entries/task/${card.id}/shares`, { method: 'POST', body: { userId: sam.user.id, level: 'view' }, ...owner })
    const viewId = `builtin.subtasks.${card.id}`

    await place(owner, viewId, { field: 'status', key: 'done', order: ['done', 'open', 'in_progress'] })
    expect(inOrder((await $fetch<Detail>(`/api/views/${viewId}`, samOpts)).columnOrder.status)).toEqual(['done', 'open', 'in_progress'])
    expect((await $fetch<Detail>(`/api/views/builtin.subtasks.${otherCard.id}`, owner)).columnOrder).toEqual({})

    const refused = await place(samOpts, viewId, { field: 'status', key: 'open', order: ['open', 'done', 'in_progress'] }).catch(e => e)
    expect(refused.statusCode).toBe(403)
    const builtIn = await place(owner, 'builtin.my-tasks', { field: 'status', key: 'done', order: ['done', 'open', 'in_progress'] }).catch(e => e)
    expect(builtIn.statusCode).toBe(403)

    const copy = await $fetch<Detail>(`/api/views/${viewId}/copy`, { method: 'POST', body: {}, ...owner })
    expect(inOrder(copy.columnOrder.status)).toEqual(['done', 'open', 'in_progress'])
  })

  it('is set and read over MCP', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await createStatusView(owner)
    const { token } = await issueMcpBearer(sql, user.id, ['views.use', 'records.read'])

    const set = await callMcpTool(token, 'views_set_column_order', { org: org.slug, view: view.id, tab: view.tabs[0]!.id, columns: ['done', 'open'] })
    expect(set.isError).toBeFalsy()
    const board = await callMcpTool(token, 'views_get_board', { org: org.slug, view: view.id, tab: view.tabs[0]!.id })
    const columns = (board.structuredContent as { columns: Array<{ key: string }> }).columns.map(c => c.key)
    expect(columns.indexOf('done')).toBeLessThan(columns.indexOf('open'))
    expect(columns.indexOf('open')).toBeLessThan(columns.indexOf('in_progress'))
  })
})
