// A view's own fields: the owner manages them, 'edit' fills them in, values
// ride on the feed and are shared by everyone who opens the view, filters,
// sorts and grouping address them like type fields, and they never reach
// the record (a person named in one gains nothing). Deleting a field or
// taking a card off the view drops its values. Copying a view copies its
// structure only. Creating a card that assigns someone who can't see it asks
// first, unless the view already shows them its cards.
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

interface FieldDef { key: string, label: string, kind: string }
interface ViewDetail {
  id: string
  name: string
  visibility: string
  definition: { picked?: true, fields?: FieldDef[], filter?: unknown }
  tabs: Array<{ id: string, layout: string, definition: Record<string, unknown> }>
}
interface Feed {
  items: Array<{ id: string, name: string, viewValues?: Record<string, unknown>, groupValues?: string[] }>
  groupFieldMissing?: boolean
}

async function pickedView(opts: Opts, body: Record<string, unknown> = {}): Promise<ViewDetail> {
  return await $fetch<ViewDetail>('/api/views', {
    method: 'POST',
    body: {
      name: 'test-views pizza',
      recordTypeKey: 'item',
      definition: { picked: true },
      tab: { layout: 'list' },
      ...body
    },
    ...opts
  })
}

async function addField(opts: Opts, viewId: string, body: Record<string, unknown>): Promise<FieldDef> {
  const res = await $fetch<{ field: FieldDef }>(`/api/views/${viewId}/fields`, { method: 'POST', body, ...opts })
  return res.field
}

async function newCard(opts: Opts, viewId: string, name: string, extra: Record<string, unknown> = {}): Promise<{ id: string }> {
  return await $fetch<{ id: string }>(`/api/views/${viewId}/cards`, {
    method: 'POST',
    body: { fields: { name }, ...extra },
    ...opts
  })
}

async function setValues(opts: Opts, viewId: string, recordId: string, values: Record<string, unknown>) {
  return await $fetch<{ viewValues: Record<string, unknown> }>(`/api/views/${viewId}/values/${recordId}`, {
    method: 'PATCH',
    body: { values },
    ...opts
  })
}

async function feed(opts: Opts, viewId: string, tabId?: string): Promise<Feed> {
  return await $fetch<Feed>(`/api/views/${viewId}/records`, { ...opts, query: tabId ? { tab: tabId } : undefined })
}

describe('view fields', () => {
  it('the owner adds fields, editors fill them in, and the feed carries the values', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const editor = await addViewsMember(sql, org.id)
    const viewer = await addViewsMember(sql, org.id)
    const editorOpts = withOrgHeader(editor.auth, org.slug)
    const viewerOpts = withOrgHeader(viewer.auth, org.slug)
    const view = await pickedView(owner)
    await $fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: editor.user.id, level: 'edit' }, ...owner })
    await $fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: viewer.user.id, level: 'view' }, ...owner })

    const temp = await addField(owner, view.id, { label: 'Oven temp', kind: 'number' })
    expect(temp.key).toMatch(/^vf_oven_temp_[0-9a-f]{6}$/)
    const rating = await addField(owner, view.id, {
      label: 'Rating',
      kind: 'key_select',
      options: { good: { label: 'Good' }, great: { label: 'Great' } }
    })
    // Only the owner shapes the view's fields.
    await expect(addField(editorOpts, view.id, { label: 'Nope', kind: 'text' })).rejects.toMatchObject({ statusCode: 403 })

    const card = await newCard(owner, view.id, 'test-views Neapolitan')
    const saved = await setValues(editorOpts, view.id, card.id, { [temp.key]: 480, [rating.key]: 'great' })
    expect(saved.viewValues).toEqual({ [temp.key]: 480, [rating.key]: 'great' })
    await expect(setValues(viewerOpts, view.id, card.id, { [temp.key]: 1 })).rejects.toMatchObject({ statusCode: 403 })
    await expect(setValues(editorOpts, view.id, card.id, { [rating.key]: 'meh' })).rejects.toMatchObject({ statusCode: 400 })

    const seen = await feed(viewerOpts, view.id)
    expect(seen.items[0]!.viewValues).toEqual({ [temp.key]: 480, [rating.key]: 'great' })

    // Values never reach the record.
    const record = await $fetch<{ fields: Record<string, unknown> }>(`/api/records/entries/item/${card.id}`, owner)
    expect(Object.keys(record.fields).some(k => k.startsWith('vf_'))).toBe(false)
  })

  it('filters, sorts and groups by a view field like a type field', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner)
    const temp = await addField(owner, view.id, { label: 'Oven temp', kind: 'number' })
    const rating = await addField(owner, view.id, {
      label: 'Rating',
      kind: 'key_select',
      options: { good: { label: 'Good' }, great: { label: 'Great' } }
    })
    const hot = await newCard(owner, view.id, 'test-views Hot')
    const warm = await newCard(owner, view.id, 'test-views Warm')
    await newCard(owner, view.id, 'test-views Unrated')
    await setValues(owner, view.id, hot.id, { [temp.key]: 480, [rating.key]: 'great' })
    await setValues(owner, view.id, warm.id, { [temp.key]: 220, [rating.key]: 'good' })

    const tab = await $fetch<{ id: string }>(`/api/views/${view.id}/tabs`, {
      method: 'POST',
      body: {
        name: 'Hot ovens',
        layout: 'table',
        definition: {
          cardFields: [temp.key],
          filter: { match: 'all', rules: [{ field: temp.key, op: 'gt', value: 300 }] }
        }
      },
      ...owner
    })
    expect((await feed(owner, view.id, tab.id)).items.map(i => i.id)).toEqual([hot.id])

    const table = await $fetch<{ id: string }>(`/api/views/${view.id}/tabs`, {
      method: 'POST',
      body: { name: 'All', layout: 'table', definition: { cardFields: [temp.key] } },
      ...owner
    })
    const sorted = await $fetch<Feed>(`/api/views/${view.id}/records`, {
      ...owner,
      query: { tab: table.id, sort: temp.key, dir: 'asc' }
    })
    expect(sorted.items.slice(0, 2).map(i => i.id)).toEqual([warm.id, hot.id])

    const board = await $fetch<{ id: string }>(`/api/views/${view.id}/tabs`, {
      method: 'POST',
      body: { name: 'By rating', layout: 'kanban', definition: { groupField: rating.key } },
      ...owner
    })
    const grouped = await feed(owner, view.id, board.id)
    expect(grouped.items.find(i => i.id === hot.id)!.groupValues).toEqual(['great'])
    expect(grouped.items.find(i => i.id === warm.id)!.groupValues).toEqual(['good'])

    // Dragging between rating columns sets the value on the view.
    await $fetch(`/api/views/${view.id}/move`, {
      method: 'POST',
      body: { tabId: board.id, recordId: warm.id, fromColumn: 'good', toColumn: 'great', columnOrder: [hot.id, warm.id] },
      ...owner
    })
    const after = await feed(owner, view.id, board.id)
    expect(after.items.find(i => i.id === warm.id)!.viewValues![rating.key]).toBe('great')
  })

  it('removing a choice clears it from cards, and a deleted field\'s key is never reused', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner)
    const rating = await addField(owner, view.id, {
      label: 'Rating',
      kind: 'key_select',
      options: { good: { label: 'Good' }, great: { label: 'Great' } }
    })
    const flavours = await addField(owner, view.id, {
      label: 'Flavours',
      kind: 'multi_select',
      options: { sweet: { label: 'Sweet' }, spicy: { label: 'Spicy' } }
    })
    const card = await newCard(owner, view.id, 'test-views Hawaiian')
    await setValues(owner, view.id, card.id, { [rating.key]: 'good', [flavours.key]: ['sweet', 'spicy'] })

    await $fetch(`/api/views/${view.id}/fields/${rating.key}`, { method: 'PATCH', body: { options: { great: { label: 'Great' } } }, ...owner })
    await $fetch(`/api/views/${view.id}/fields/${flavours.key}`, { method: 'PATCH', body: { options: { spicy: { label: 'Spicy' } } }, ...owner })
    expect((await feed(owner, view.id)).items[0]!.viewValues).toEqual({ [flavours.key]: ['spicy'] })
    // The card stays writable.
    await setValues(owner, view.id, card.id, { [rating.key]: 'great' })

    await $fetch(`/api/views/${view.id}/fields/${rating.key}`, { method: 'DELETE', ...owner })
    const again = await addField(owner, view.id, { label: 'Rating', kind: 'number' })
    expect(again.key).not.toBe(rating.key)
  })

  it('a contains filter on a links field matches the links, not their shape', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner)
    const recipe = await addField(owner, view.id, { label: 'Recipe', kind: 'link' })
    const card = await newCard(owner, view.id, 'test-views Margherita')
    await setValues(owner, view.id, card.id, { [recipe.key]: [{ url: 'example.com/margherita', label: 'Classic' }] })
    const tabFor = async (value: string) => (await $fetch<{ id: string }>(`/api/views/${view.id}/tabs`, {
      method: 'POST',
      body: { name: value, layout: 'table', definition: { filter: { match: 'all', rules: [{ field: recipe.key, op: 'contains', value }] } } },
      ...owner
    })).id
    expect((await feed(owner, view.id, await tabFor('url'))).items).toHaveLength(0)
    expect((await feed(owner, view.id, await tabFor('margherita'))).items).toHaveLength(1)
    expect((await feed(owner, view.id, await tabFor('classic'))).items).toHaveLength(1)
  })

  it('a new card takes the view values it is created with', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner)
    const tried = await addField(owner, view.id, { label: 'Tried', kind: 'boolean' })
    const card = await newCard(owner, view.id, 'test-views Detroit', { viewValues: { [tried.key]: true } })
    const res = await feed(owner, view.id)
    expect(res.items.find(i => i.id === card.id)!.viewValues).toEqual({ [tried.key]: true })
  })

  it('deleting a field drops its values and takes it out of filters and card fields', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner)
    const temp = await addField(owner, view.id, { label: 'Oven temp', kind: 'number' })
    const card = await newCard(owner, view.id, 'test-views Roman')
    await setValues(owner, view.id, card.id, { [temp.key]: 300 })
    await $fetch(`/api/views/${view.id}/tabs/${view.tabs[0]!.id}`, {
      method: 'PATCH',
      body: {
        definition: {
          cardFields: ['status', temp.key],
          filter: { match: 'all', rules: [{ field: temp.key, op: 'gt', value: 100 }] }
        }
      },
      ...owner
    })

    const updated = await $fetch<ViewDetail>(`/api/views/${view.id}/fields/${temp.key}`, { method: 'DELETE', ...owner })
    expect(updated.definition.fields).toBeUndefined()
    expect(updated.tabs[0]!.definition).toEqual({ cardFields: ['status'] })
    const rows = await sql`SELECT 1 FROM views_values WHERE view_id = ${view.id}`
    expect(rows).toHaveLength(0)
    expect((await feed(owner, view.id)).items.map(i => i.id)).toEqual([card.id])
  })

  it('taking a card off the view drops its values there', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner)
    const note = await addField(owner, view.id, { label: 'Note', kind: 'text' })
    const card = await newCard(owner, view.id, 'test-views Sicilian')
    await setValues(owner, view.id, card.id, { [note.key]: 'thick crust' })
    await $fetch(`/api/views/${view.id}/cards/${card.id}`, { method: 'DELETE', ...owner })
    const rows = await sql`SELECT 1 FROM views_values WHERE view_id = ${view.id} AND record_id = ${card.id}`
    expect(rows).toHaveLength(0)
  })

  it('a person named in a view field gains no access to the card', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const other = await addViewsMember(sql, org.id)
    const otherOpts = withOrgHeader(other.auth, org.slug)
    const view = await pickedView(owner)
    const reviewer = await addField(owner, view.id, { label: 'Reviewer', kind: 'user_select' })
    const card = await newCard(owner, view.id, 'test-views Private pie')
    await setValues(owner, view.id, card.id, { [reviewer.key]: other.user.id })

    await expect($fetch(`/api/records/entries/item/${card.id}`, otherOpts)).rejects.toMatchObject({ statusCode: 404 })
    // "@me" still finds the cards naming whoever looks.
    const tab = await $fetch<{ id: string }>(`/api/views/${view.id}/tabs`, {
      method: 'POST',
      body: { name: 'Mine to review', layout: 'list', definition: { filter: { match: 'all', rules: [{ field: reviewer.key, op: 'is', value: '@me' }] } } },
      ...owner
    })
    expect((await feed(owner, view.id, tab.id)).items).toHaveLength(0)
    await setValues(owner, view.id, card.id, { [reviewer.key]: user.id })
    expect((await feed(owner, view.id, tab.id)).items.map(i => i.id)).toEqual([card.id])
  })

  it('works on a view of every matching record too', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await $fetch<ViewDetail>('/api/views', {
      method: 'POST',
      body: { name: 'test-views All tasks', recordTypeKey: 'task', tab: { layout: 'table' } },
      ...owner
    })
    const effort = await addField(owner, view.id, { label: 'Effort', kind: 'number' })
    const task = await $fetch<{ id: string }>('/api/records/entries/task', {
      method: 'POST',
      body: { fields: { name: 'test-views Plan Q3' } },
      ...owner
    })
    await setValues(owner, view.id, task.id, { [effort.key]: 3 })
    const res = await feed(owner, view.id)
    expect(res.items.find(i => i.id === task.id)!.viewValues).toEqual({ [effort.key]: 3 })
  })

  it('copying a view copies its fields and tabs, private and without cards', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const other = await addViewsMember(sql, org.id)
    const otherOpts = withOrgHeader(other.auth, org.slug)
    const view = await pickedView(owner, { visibility: 'org' })
    await addField(owner, view.id, { label: 'Rating', kind: 'number' })
    await newCard(owner, view.id, 'test-views Original card')

    const copy = await $fetch<ViewDetail>(`/api/views/${view.id}/copy`, { method: 'POST', body: {}, ...otherOpts })
    expect(copy.name).toBe('Copy of test-views pizza')
    expect(copy.visibility).toBe('private')
    expect(copy.definition.picked).toBe(true)
    expect(copy.definition.fields!.map(f => f.label)).toEqual(['Rating'])
    expect(copy.tabs.map(t => t.layout)).toEqual(view.tabs.map(t => t.layout))
    expect((await feed(otherOpts, copy.id)).items).toHaveLength(0)
  })
})

describe('assigning from a view', () => {
  it('asks before a new card assigns someone who can\'t see it, unless the view shows them its cards', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addViewsMember(sql, org.id)
    const privateView = await pickedView(owner, { recordTypeKey: 'task' })

    const refused = await newCard(owner, privateView.id, 'test-views Call Sam', { fields: { name: 'test-views Call Sam', assignee: sam.user.id } })
      .catch((e: { statusCode: number, data: { data: { code: string } } }) => e)
    expect((refused as { statusCode: number }).statusCode).toBe(409)
    expect((refused as { data: { data: { code: string } } }).data.data.code).toBe('records.share_confirmation')
    const confirmed = await newCard(owner, privateView.id, 'x', {
      fields: { name: 'test-views Call Sam', assignee: sam.user.id },
      confirmShare: true
    })
    expect(confirmed.id).toBeTruthy()

    // Sam can already open this view, so its cards are already his to see.
    const shared = await pickedView(owner, { recordTypeKey: 'task' })
    await $fetch(`/api/views/${shared.id}/shares`, { method: 'POST', body: { userId: sam.user.id, level: 'view' }, ...owner })
    const card = await newCard(owner, shared.id, 'x', { fields: { name: 'test-views Email Sam', assignee: sam.user.id } })
    expect(card.id).toBeTruthy()
  })
})

describe('view fields over MCP', () => {
  it('an agent adds a field, creates a card with a value and reads it back', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner, {
      tab: { layout: 'kanban', definition: { columns: [{ key: 'todo', label: 'To do' }] } }
    })
    const { token } = await issueMcpBearer(sql, user.id, ['views.use', 'records.read', 'records.write'])

    const added = await callMcpTool(token, 'views_add_field', {
      org: org.slug, view: view.id, label: 'Rating', kind: 'key_select', options: ['Good', 'Great']
    })
    expect(added.isError).toBeFalsy()
    const field = (added.structuredContent as { field: { key: string, options: Record<string, { label: string }> } }).field
    expect(Object.keys(field.options)).toEqual(['good', 'great'])

    const created = await callMcpTool(token, 'views_create_card', {
      org: org.slug, view: view.id, fields: { name: 'test-views Agent pie' }, values: { [field.key]: 'great' }
    })
    expect(created.isError).toBeFalsy()
    const board = await callMcpTool(token, 'views_get_board', { org: org.slug, view: view.id })
    const cards = (board.structuredContent as { columns: Array<{ cards: Array<{ name: string, values?: Record<string, unknown> }> }> }).columns[0]!.cards
    expect(cards[0]).toMatchObject({ name: 'test-views Agent pie', values: { [field.key]: 'great' } })
  })
})

describe('subtasks', () => {
  it('a task card shows its subtasks\' progress, counting tasks that name it as parent', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await $fetch<ViewDetail>('/api/views', {
      method: 'POST',
      body: { name: 'test-views Tasks', recordTypeKey: 'task', tab: { layout: 'kanban', definition: { groupField: 'status' } } },
      ...owner
    })
    const parent = await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields: { name: 'test-views Launch' } }, ...owner })
    for (const [name, status] of [['test-views Write copy', 'done'], ['test-views Ship it', 'open']]) {
      await $fetch('/api/records/entries/task', { method: 'POST', body: { fields: { name, status, parent: [parent.id] } }, ...owner })
    }
    const res = await $fetch<{ items: Array<{ id: string, progress?: Record<string, { total: number, done: number }> }> }>(`/api/views/${view.id}/records`, owner)
    expect(res.items.find(i => i.id === parent.id)!.progress!.subtasks).toEqual({ total: 2, done: 1 })
  })
})
