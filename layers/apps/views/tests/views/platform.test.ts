// The views features built on the records platform: boards grouped by tags
// and by connections (the milestone ritual), shared custom boards granting
// visibility of personal items — but never of contacts — and card layouts
// that start from the record type's default.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  addViewsMember,
  createViewsRole,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Feed {
  items: Array<{ id: string, name: string, groupValues?: string[], progress?: Record<string, { total: number, done: number }> }>
  placements: Array<{ recordId: string, columnKey: string }>
  groupColumns?: Array<{ key: string, label: string }>
  card: { fields: string[], connections: Record<string, string>, custom: boolean }
}

// A view with one board tab; a board with its own columns makes it a view of
// hand-picked records.
async function createView(opts: Opts, body: { recordTypeKey: string, visibility?: string, definition: Record<string, unknown> }): Promise<{ id: string, tabs: Array<{ id: string }> }> {
  const { definition, ...rest } = body
  return await $fetch<{ id: string, tabs: Array<{ id: string }> }>('/api/views', {
    method: 'POST',
    body: {
      name: 'test-views platform',
      visibility: 'private',
      ...rest,
      definition: definition.columns ? { picked: true } : {},
      tab: { layout: 'kanban', definition }
    },
    ...opts
  })
}

async function createRecord(opts: Opts, type: string, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>(`/api/records/entries/${type}`, { method: 'POST', body: { fields }, ...opts })
}

async function getFields(opts: Opts, type: string, id: string): Promise<Record<string, unknown>> {
  return (await $fetch<{ fields: Record<string, unknown> }>(`/api/records/entries/${type}/${id}`, opts)).fields
}

async function feed(opts: Opts, viewId: string): Promise<Feed> {
  return await $fetch<Feed>(`/api/views/${viewId}/records`, opts)
}

async function move(opts: Opts, viewId: string, body: Record<string, unknown>): Promise<void> {
  await $fetch(`/api/views/${viewId}/move`, { method: 'POST', body, ...opts })
}

describe('grouping by tags', () => {
  it('columns come from the tags on cards, and a drag adds the target tag', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { recordTypeKey: 'item', definition: { groupField: 'tags' } })
    const idea = await createRecord(opts, 'item', { name: 'test-views Pizza dough', tags: ['ideas'] })

    expect((await feed(opts, view.id)).items.find(i => i.id === idea.id)?.groupValues).toEqual(['ideas'])

    // A tag column with no cards yet still takes a drop: the tag is new.
    await move(opts, view.id, { recordId: idea.id, fromColumn: 'ideas', toColumn: 'tried', columnOrder: [idea.id] })
    const tags = (await getFields(opts, 'item', idea.id)).tags as string[]
    expect([...tags].sort()).toEqual(['ideas', 'tried'])
  })
})

describe('grouping by a connection (milestones)', () => {
  it('columns are the target records, a drag carries the card forward, and progress counts done children', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    // The org builds its own types: milestones, and deliverables linked to
    // them and to tasks.
    await $fetch('/api/records/schema/types', { method: 'POST', body: { typeKey: 'test_views_milestones', label: 'Milestones', labelSingular: 'Milestone' }, ...opts })
    await $fetch('/api/records/schema/types', { method: 'POST', body: { typeKey: 'test_views_deliverables', label: 'Deliverables', labelSingular: 'Deliverable' }, ...opts })
    await $fetch('/api/records/schema/types/test_views_deliverables/fields', {
      method: 'POST',
      body: { fieldKey: 'milestones', kind: 'connection', label: 'Milestones', target: 'test_views_milestones' },
      ...opts
    })
    await $fetch('/api/records/schema/types/test_views_deliverables/fields', {
      method: 'POST',
      body: { fieldKey: 'tasks', kind: 'connection', label: 'Tasks', target: 'task' },
      ...opts
    })

    const q4 = await createRecord(opts, 'test_views_milestones', { name: '2026-Q4' })
    const q1 = await createRecord(opts, 'test_views_milestones', { name: '2027-Q1' })
    const done = await createRecord(opts, 'task', { name: 'test-views Draft', status: 'done' })
    const open = await createRecord(opts, 'task', { name: 'test-views Review' })
    const deliverable = await createRecord(opts, 'test_views_deliverables', {
      name: 'test-views Website', milestones: [q4.id], tasks: [done.id, open.id]
    })

    const view = await createView(opts, {
      recordTypeKey: 'test_views_deliverables',
      definition: { groupField: 'milestones', cardFields: ['tasks'], cardConnections: { tasks: 'progress' } }
    })
    let res = await feed(opts, view.id)
    expect(res.groupColumns?.map(c => c.label)).toEqual(['2026-Q4', '2027-Q1'])
    const card = res.items.find(i => i.id === deliverable.id)!
    expect(card.groupValues).toEqual([q4.id])
    expect(card.progress?.tasks).toEqual({ total: 2, done: 1 })

    // The quarterly ritual: carried into next quarter, it keeps this one.
    await move(opts, view.id, { recordId: deliverable.id, fromColumn: q4.id, toColumn: q1.id, columnOrder: [deliverable.id] })
    const linked = (await getFields(opts, 'test_views_deliverables', deliverable.id)).milestones as Array<{ id: string }>
    expect(linked.map(m => m.id).sort()).toEqual([q4.id, q1.id].sort())
    res = await feed(opts, view.id)
    expect(res.items.find(i => i.id === deliverable.id)?.groupValues?.sort()).toEqual([q4.id, q1.id].sort())
  })
})

describe('shared custom boards grant visibility', () => {
  it('a personal item on a shared board becomes visible to the people it is shared with, and only them', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const friend = await addViewsMember(sql, org.id)
    const stranger = await addViewsMember(sql, org.id)
    const friendOpts = withOrgHeader(friend.auth, org.slug)
    const strangerOpts = withOrgHeader(stranger.auth, org.slug)

    const item = await createRecord(owner, 'item', { name: 'test-views Secret recipe' })
    // Items are personal by default: members have no view_all.
    await expect($fetch(`/api/records/entries/item/${item.id}`, friendOpts)).rejects.toMatchObject({ statusCode: 404 })

    const board = await createView(owner, {
      recordTypeKey: 'item',
      definition: { columns: [{ key: 'ideas', label: 'Ideas' }] }
    })
    await $fetch(`/api/views/${board.id}/shares`, { method: 'POST', body: { userId: friend.user.id, level: 'view' }, ...owner })
    await $fetch(`/api/views/${board.id}/cards`, { method: 'POST', body: { recordId: item.id, columnKey: 'ideas' }, ...owner })

    const seen = await feed(friendOpts, board.id)
    expect(seen.items.map(i => i.id)).toEqual([item.id])
    expect((await $fetch<{ name: string }>(`/api/records/entries/item/${item.id}`, friendOpts)).name).toBe('test-views Secret recipe')
    await expect($fetch(`/api/records/entries/item/${item.id}`, strangerOpts)).rejects.toMatchObject({ statusCode: 404 })

    // Taking the card off the board takes the visibility with it.
    await $fetch(`/api/views/${board.id}/cards/${item.id}`, { method: 'DELETE', ...owner })
    await expect($fetch(`/api/records/entries/item/${item.id}`, friendOpts)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('adding a card takes the share permission on types whose boards grant visibility', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const role = await createViewsRole(sql, org.id, ['views.use', 'records.access', 'records.entries.read', 'records.entries.create'])
    const noShare = await addViewsMember(sql, org.id, [role])
    const noShareOpts = withOrgHeader(noShare.auth, org.slug)

    const board = await createView(owner, {
      recordTypeKey: 'item',
      visibility: 'org',
      definition: { columns: [{ key: 'ideas', label: 'Ideas' }] }
    })
    const own = await createRecord(noShareOpts, 'item', { name: 'test-views Not for sharing' })
    await expect($fetch(`/api/views/${board.id}/cards`, {
      method: 'POST',
      body: { recordId: own.id, columnKey: 'ideas' },
      ...noShareOpts
    })).rejects.toMatchObject({ statusCode: 403 })
    expect((await feed(owner, board.id)).items).toEqual([])
  })

  it('never widens who sees a contact', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const friend = await addViewsMember(sql, org.id)
    const friendOpts = withOrgHeader(friend.auth, org.slug)

    const contact = await createRecord(owner, 'contacts', { name: 'test-views Private Person' })
    const board = await createView(owner, {
      recordTypeKey: 'contacts',
      visibility: 'org',
      definition: { columns: [{ key: 'todo', label: 'To do' }] }
    })
    await $fetch(`/api/views/${board.id}/cards`, { method: 'POST', body: { recordId: contact.id, columnKey: 'todo' }, ...owner })

    expect((await feed(friendOpts, board.id)).items).toEqual([])
    await expect($fetch(`/api/records/entries/contacts/${contact.id}`, friendOpts)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('card layouts', () => {
  it('a view renders its type\'s default layout until it saves its own', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { recordTypeKey: 'task', definition: { groupField: 'status' } })

    let res = await feed(opts, view.id)
    expect(res.card).toEqual({ fields: ['status', 'assignee', 'due_date'], connections: {}, custom: false })

    await $fetch(`/api/views/${view.id}/tabs/${view.tabs[0]!.id}`, {
      method: 'PATCH',
      body: { definition: { groupField: 'status', cardFields: ['due_date'] } },
      ...opts
    })
    res = await feed(opts, view.id)
    expect(res.card).toMatchObject({ fields: ['due_date'], custom: true })

    // The type default can change; a view with its own layout keeps it.
    await $fetch('/api/records/schema/types/task', { method: 'PATCH', body: { card: { fields: ['assignee'] } }, ...opts })
    res = await feed(opts, view.id)
    expect(res.card.fields).toEqual(['due_date'])
  })
})
