// Calendar tabs: they need a date field and take no grouping; switching away
// drops their date fields; the feed holds the records on the requested days
// (spanning to an end date when there is one) plus the undated ones; and
// cards on a calendar move by changing their date, never by placement.
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

interface Tab { id: string, name: string, layout: string, definition: Record<string, unknown> }
interface View { id: string, tabs: Tab[] }
interface Feed {
  items: Array<{ id: string, name: string }>
  unscheduled?: { items: Array<{ id: string }>, total: number }
}

async function createView(opts: Opts, tab: Record<string, unknown>): Promise<View> {
  return await $fetch<View>('/api/views', {
    method: 'POST',
    body: { name: 'test-views calendar', recordTypeKey: 'task', tab },
    ...opts
  })
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<string> {
  return (await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields }, ...opts })).id
}

async function feed(opts: Opts, viewId: string, query: Record<string, string>): Promise<Feed> {
  return await $fetch<Feed>(`/api/views/${viewId}/records`, { query, ...opts })
}

describe('calendar tabs', () => {
  it('need a date field, and take no grouping or columns', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect(createView(opts, { layout: 'calendar' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(createView(opts, { layout: 'calendar', definition: { dateField: 'nope' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(createView(opts, { layout: 'calendar', definition: { dateField: 'priority' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(createView(opts, { layout: 'calendar', definition: { dateField: 'due_date', groupField: 'status' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(createView(opts, { layout: 'calendar', definition: { dateField: 'due_date', endField: 'due_date' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(createView(opts, { layout: 'list', definition: { dateField: 'due_date' } }))
      .rejects.toMatchObject({ statusCode: 400 })

    const view = await createView(opts, { layout: 'calendar', definition: { dateField: 'start_date', endField: 'due_date' } })
    expect(view.tabs[0]).toMatchObject({ name: 'Calendar', layout: 'calendar', definition: { dateField: 'start_date', endField: 'due_date' } })
    const created = await createView(opts, { layout: 'calendar', definition: { dateField: 'created_at' } })
    expect(created.tabs[0]!.definition).toEqual({ dateField: 'created_at' })
  })

  it('drop their date fields when switched to another layout', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { layout: 'calendar', definition: { dateField: 'due_date' } })
    const tab = await $fetch<Tab>(`/api/views/${view.id}/tabs/${view.tabs[0]!.id}`, {
      method: 'PATCH',
      body: { layout: 'list' },
      ...opts
    })
    expect(tab).toMatchObject({ layout: 'list', definition: {} })
  })

  it('show the records on the requested days, spans to the end date, and the undated ones', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const inMonth = await createTask(opts, { name: 'In November', due_date: '2026-11-12' })
    const before = await createTask(opts, { name: 'In September', due_date: '2026-09-03' })
    const spanning = await createTask(opts, { name: 'October into November', start_date: '2026-10-20', due_date: '2026-11-02' })
    const undated = await createTask(opts, { name: 'No date' })

    const due = await createView(opts, { layout: 'calendar', definition: { dateField: 'due_date' } })
    const november = await feed(opts, due.id, { from: '2026-11-01', to: '2026-11-30' })
    expect(november.items.map(i => i.id).sort()).toEqual([inMonth, spanning].sort())
    expect(november.unscheduled?.items.map(i => i.id)).toEqual([undated])
    expect(november.unscheduled?.total).toBe(1)

    const span = await createView(opts, { layout: 'calendar', definition: { dateField: 'start_date', endField: 'due_date' } })
    const early = await feed(opts, span.id, { from: '2026-11-01', to: '2026-11-07' })
    expect(early.items.map(i => i.id)).toEqual([spanning])
    const september = await feed(opts, span.id, { from: '2026-09-01', to: '2026-09-30' })
    expect(september.items.map(i => i.id)).not.toContain(before)
    expect(september.unscheduled?.items.map(i => i.id).sort()).toEqual([inMonth, before, undated].sort())

    await expect(feed(opts, due.id, { from: 'November', to: '2026-11-30' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuse placement moves', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const task = await createTask(opts, { name: 'Dated', due_date: '2026-11-12' })
    const view = await createView(opts, { layout: 'calendar', definition: { dateField: 'due_date' } })
    await expect($fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { tabId: view.tabs[0]!.id, recordId: task, fromColumn: null, toColumn: '', columnOrder: [task] },
      ...opts
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
