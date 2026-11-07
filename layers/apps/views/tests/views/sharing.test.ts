// Sharing a view: teams and Everyone at a level, hand-picked views sharing
// their cards (edit at 'edit', comment at 'view'), the view's own cards
// (created, deleted, and deleted with the view), owner-only access settings,
// and views over every matching record granting nothing.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  addViewsMember,
  createViewsRole,
  createViewsUser,
  addTestMembership,
  getAuthHeaders,
  issueMcpBearer,
  callMcpTool,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface ViewDetail {
  id: string
  accessLevel: 'view' | 'edit' | 'owner'
  ownCardCount: number
  teams: Array<{ id: string, level: 'view' | 'edit' }>
  tabs: Array<{ id: string }>
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ statusCode: status })
}

async function pickedView(opts: Opts, body: Record<string, unknown> = {}): Promise<ViewDetail> {
  return await $fetch<ViewDetail>('/api/views', {
    method: 'POST',
    body: {
      name: 'test-views onboarding',
      recordTypeKey: 'item',
      definition: { picked: true },
      tab: { layout: 'kanban', definition: { columns: [{ key: 'todo', label: 'To do' }] } },
      ...body
    },
    ...opts
  })
}

async function newCard(opts: Opts, viewId: string, name: string): Promise<{ id: string }> {
  return await $fetch<{ id: string }>(`/api/views/${viewId}/cards`, {
    method: 'POST',
    body: { fields: { name }, columnKey: 'todo' },
    ...opts
  })
}

async function makeTeam(owner: Opts, orgSlug: string, memberIds: string[]): Promise<string> {
  const team = await $fetch<{ id: string }>(`/api/o/${orgSlug}/groups`, {
    method: 'POST',
    body: { name: `test-views-team-${Math.random().toString(36).slice(2, 8)}` },
    ...owner
  })
  for (const id of memberIds) {
    await $fetch(`/api/o/${orgSlug}/groups/${team.id}/members/${id}`, { method: 'PUT', ...owner })
  }
  return team.id
}

describe('team and Everyone levels', () => {
  it('a team at edit can edit the cards of a hand-picked view; a team at view can read and comment', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    // Neither role can update items, so editing can only come from the view.
    const readOnly = await createViewsRole(sql, org.id, ['views.use', 'records.access', 'records.entries.read'])
    const editor = await addViewsMember(sql, org.id, [readOnly])
    const watcher = await addViewsMember(sql, org.id, [readOnly])
    const editorOpts = withOrgHeader(editor.auth, org.slug)
    const watcherOpts = withOrgHeader(watcher.auth, org.slug)
    const editors = await makeTeam(owner, org.slug, [editor.user.id])
    const watchers = await makeTeam(owner, org.slug, [watcher.user.id])

    const view = await pickedView(owner, {
      visibility: 'teams',
      teamIds: [editors, watchers],
      teamLevels: { [editors]: 'edit' }
    })
    expect(Object.fromEntries(view.teams.map(t => [t.id, t.level]))).toEqual({ [editors]: 'edit', [watchers]: 'view' })
    const card = await newCard(owner, view.id, 'test-views Welcome pack')

    expect((await $fetch<ViewDetail>(`/api/views/${view.id}`, editorOpts)).accessLevel).toBe('edit')
    // Items are personal; the view shares this one with both teams.
    await $fetch(`/api/records/entries/item/${card.id}`, { method: 'PATCH', body: { fields: { name: 'test-views Welcome kit' } }, ...editorOpts })
    expect((await $fetch<{ name: string }>(`/api/records/entries/item/${card.id}`, watcherOpts)).name).toBe('test-views Welcome kit')
    await expectStatus($fetch(`/api/records/entries/item/${card.id}`, { method: 'PATCH', body: { fields: { name: 'x' } }, ...watcherOpts }), 403)
    await $fetch(`/api/records/entries/item/${card.id}/comments`, { method: 'POST', body: { body: 'test-views question' }, ...watcherOpts })

    const shares = await $fetch<{ via: Array<{ label: string, audience: Array<{ kind: string, level: string }> }> }>(
      `/api/records/entries/item/${card.id}/shares`, owner
    )
    expect(shares.via).toHaveLength(1)
    expect(shares.via[0]!.audience.filter(a => a.kind === 'team').map(a => a.level).sort()).toEqual(['edit', 'view'])
  })

  it('Everyone at edit makes every member an editor of an org-wide view', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const member = withOrgHeader((await addViewsMember(sql, org.id)).auth, org.slug)

    const view = await pickedView(owner, { visibility: 'org', orgLevel: 'edit' })
    expect((await $fetch<ViewDetail>(`/api/views/${view.id}`, member)).accessLevel).toBe('edit')
    await $fetch(`/api/views/${view.id}`, { method: 'PATCH', body: { visibility: 'org', orgLevel: 'view' }, ...owner })
    expect((await $fetch<ViewDetail>(`/api/views/${view.id}`, member)).accessLevel).toBe('view')
  })
})

describe('owner-only settings', () => {
  it('editors change tabs but not sharing or the base filter', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const editor = await addViewsMember(sql, org.id)
    const other = await addViewsMember(sql, org.id)
    const editorOpts = withOrgHeader(editor.auth, org.slug)

    const view = await pickedView(owner)
    await $fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: editor.user.id, level: 'edit' }, ...owner })

    await $fetch(`/api/views/${view.id}/tabs`, { method: 'POST', body: { layout: 'list' }, ...editorOpts })
    await expectStatus($fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: other.user.id, level: 'view' }, ...editorOpts }), 403)
    await expectStatus($fetch(`/api/views/${view.id}`, { method: 'PATCH', body: { definition: { filter: null } }, ...editorOpts }), 403)
    await expectStatus($fetch(`/api/views/${view.id}`, { method: 'PATCH', body: { visibility: 'org' }, ...editorOpts }), 403)
  })

  it('over MCP, editors set a tab\'s filter but not the base filter', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const editor = await addViewsMember(sql, org.id)
    const view = await pickedView(owner)
    await $fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: editor.user.id, level: 'edit' }, ...owner })
    const { token } = await issueMcpBearer(sql, editor.user.id, ['views.use'])
    const filter = { match: 'all', rules: [] }

    const tab = await callMcpTool(token, 'views_set_filter', { org: org.slug, view: view.id, tab: view.tabs[0]!.id, filter })
    expect(tab.isError).toBeFalsy()
    const base = await callMcpTool(token, 'views_set_filter', { org: org.slug, view: view.id, filter })
    expect(base.isError).toBe(true)
  })
})

describe('who a view is shared with', () => {
  it('is limited to people in the org, for shares and for a new owner', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const outsider = await createViewsOrgWith(sql, ['admin'])
    const view = await pickedView(owner)

    await expectStatus($fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: outsider.user.id, level: 'view' }, ...owner }), 404)

    const operator = await createViewsUser(sql, { is_admin: true })
    await addTestMembership(sql, { user_id: operator.id, org_id: org.id, roles: ['member'] })
    const operatorOpts = withOrgHeader(getAuthHeaders(operator), org.slug)
    await expectStatus($fetch(`/api/views/admin/${view.id}/owner`, { method: 'PATCH', body: { userId: outsider.user.id }, ...operatorOpts }), 404)
  })

  it('shows on a record\'s share list only to callers who can open the view', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const reader = await addViewsMember(sql, org.id)
    const readerOpts = withOrgHeader(reader.auth, org.slug)
    const view = await pickedView(owner, { name: 'test-views private board' })
    const card = await newCard(owner, view.id, 'test-views Shared directly')
    await $fetch(`/api/records/entries/item/${card.id}/shares`, { method: 'POST', body: { userId: reader.user.id }, ...owner })

    type Shares = { via: Array<{ label: string }> }
    expect((await $fetch<Shares>(`/api/records/entries/item/${card.id}/shares`, owner)).via.map(v => v.label)).toEqual(['test-views private board'])
    expect((await $fetch<Shares>(`/api/records/entries/item/${card.id}/shares`, readerOpts)).via).toEqual([])
  })
})

describe('a hand-picked view\'s own cards', () => {
  it('editors create cards without create on the type, and delete only the ones created there', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const role = await createViewsRole(sql, org.id, ['views.use', 'records.access', 'records.entries.read'])
    const editor = await addViewsMember(sql, org.id, [role])
    const editorOpts = withOrgHeader(editor.auth, org.slug)

    const view = await pickedView(owner)
    await $fetch(`/api/views/${view.id}/shares`, { method: 'POST', body: { userId: editor.user.id, level: 'edit' }, ...owner })

    const own = await newCard(editorOpts, view.id, 'test-views Made here')
    const fromElsewhere = await $fetch<{ id: string }>('/api/records/entries/item', { method: 'POST', body: { fields: { name: 'test-views Made elsewhere' } }, ...owner })
    await $fetch(`/api/views/${view.id}/cards`, { method: 'POST', body: { recordId: fromElsewhere.id, columnKey: 'todo' }, ...owner })

    const feed = await $fetch<{ items: Array<{ id: string, ownCard?: true }> }>(`/api/views/${view.id}/records`, editorOpts)
    expect(feed.items.find(i => i.id === own.id)?.ownCard).toBe(true)
    expect(feed.items.find(i => i.id === fromElsewhere.id)?.ownCard).toBeUndefined()

    await expectStatus($fetch(`/api/views/${view.id}/cards/${fromElsewhere.id}`, { method: 'DELETE', query: { record: 'delete' }, ...editorOpts }), 403)
    await $fetch(`/api/views/${view.id}/cards/${own.id}`, { method: 'DELETE', query: { record: 'delete' }, ...editorOpts })
    await expectStatus($fetch(`/api/records/entries/item/${own.id}`, owner), 404)
  })

  it('a card on another view too is no longer the view\'s own', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const first = await pickedView(owner)
    const second = await pickedView(owner)
    const card = await newCard(owner, first.id, 'test-views Shared card')
    expect((await $fetch<ViewDetail>(`/api/views/${first.id}`, owner)).ownCardCount).toBe(1)

    await $fetch(`/api/views/${second.id}/cards`, { method: 'POST', body: { recordId: card.id, columnKey: 'todo' }, ...owner })
    expect((await $fetch<ViewDetail>(`/api/views/${first.id}`, owner)).ownCardCount).toBe(0)
  })

  it('deleting the view deletes its own cards and keeps the rest', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await pickedView(owner)
    const own = await newCard(owner, view.id, 'test-views Goes with the view')
    const kept = await $fetch<{ id: string }>('/api/records/entries/item', { method: 'POST', body: { fields: { name: 'test-views Stays' } }, ...owner })
    await $fetch(`/api/views/${view.id}/cards`, { method: 'POST', body: { recordId: kept.id, columnKey: 'todo' }, ...owner })

    await $fetch(`/api/views/${view.id}`, { method: 'DELETE', ...owner })
    await expectStatus($fetch(`/api/records/entries/item/${own.id}`, owner), 404)
    expect((await $fetch<{ id: string }>(`/api/records/entries/item/${kept.id}`, owner)).id).toBe(kept.id)
  })

  it('an operator admin\'s delete takes the view\'s own cards too', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const operator = await createViewsUser(sql, { is_admin: true })
    await addTestMembership(sql, { user_id: operator.id, org_id: org.id, roles: ['member'] })
    const operatorOpts = withOrgHeader(getAuthHeaders(operator), org.slug)
    const view = await pickedView(owner)
    const own = await newCard(owner, view.id, 'test-views Goes with the view')

    await $fetch(`/api/views/admin/${view.id}`, { method: 'DELETE', ...operatorOpts })
    await expectStatus($fetch(`/api/records/entries/item/${own.id}`, owner), 404)
  })
})

describe('views of every matching record', () => {
  it('grant nothing: the feed applies the type\'s read permission', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const member = withOrgHeader((await addViewsMember(sql, org.id)).auth, org.slug)
    const view = await $fetch<ViewDetail>('/api/views', {
      method: 'POST',
      body: { name: 'test-views all tasks', recordTypeKey: 'task', visibility: 'org', tab: { layout: 'table' } },
      ...owner
    })
    await $fetch(`/api/views/${view.id}/records`, member)

    await $fetch('/api/records/schema/types/task/role-grants', { method: 'PUT', body: { grants: { member: { read: false } } }, ...owner })
    await expectStatus($fetch(`/api/views/${view.id}/records`, member), 403)
  })
})
