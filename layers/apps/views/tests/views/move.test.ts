// Field-grouped board semantics through the records feed and move route:
// grouping values on the feed, the single-value write, the multi-value swap
// rule (drop the source column's value, keep the rest), the No-value
// column, manual ranks, staleness, and the CRM permission gate on moves.
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
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface FeedItem {
  id: string
  name: string
  groupValues?: string[]
}
interface Feed {
  items: FeedItem[]
  total: number
  placements: Array<{ recordId: string, columnKey: string, rank: string | null }>
  groupFieldMissing: boolean
}

async function createView(opts: Opts, definition: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/views', {
    method: 'POST',
    body: {
      name: 'test-views move board',
      recordTypeKey: 'contacts',
      visibility: 'org',
      tab: { layout: 'kanban', definition }
    },
    ...opts
  })
}

async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields },
    ...opts
  })
}

async function feed(opts: Opts, viewId: string): Promise<Feed> {
  return await $fetch<Feed>(`/api/views/${viewId}/records`, opts)
}

async function move(opts: Opts, viewId: string, body: Record<string, unknown>): Promise<unknown> {
  return $fetch(`/api/views/${viewId}/move`, { method: 'POST', body, ...opts })
}

async function recordFields(opts: Opts, id: string): Promise<Record<string, unknown>> {
  const res = await $fetch<{ fields: Record<string, unknown> }>(`/api/records/entries/contacts/${id}`, opts)
  return res.fields
}

describe('field-grouped moves', () => {
  it('serves grouping values and writes a single-value move', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'status' })
    const rec = await createContact(opts, { name: 'test-views Single', status: 'new' })

    let res = await feed(opts, view.id)
    expect(res.items.find(i => i.id === rec.id)?.groupValues).toEqual(['new'])

    await move(opts, view.id, {
      recordId: rec.id, fromColumn: 'new', toColumn: 'active', columnOrder: [rec.id]
    })
    expect((await recordFields(opts, rec.id)).status).toBe('active')

    res = await feed(opts, view.id)
    expect(res.items.find(i => i.id === rec.id)?.groupValues).toEqual(['active'])

    // A status board has no No-value column.
    await expect(move(opts, view.id, {
      recordId: rec.id, fromColumn: 'active', toColumn: '', columnOrder: [rec.id]
    })).rejects.toMatchObject({ statusCode: 400 })
    expect((await recordFields(opts, rec.id)).status).toBe('active')
  })

  it('a multi-select drag adds the target value and keeps the source', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'languages' })
    const rec = await createContact(opts, {
      name: 'test-views Multi', languages: ['en', 'es']
    })

    // Dragged from 'en' into 'fr': the card now sits in en, es and fr.
    await move(opts, view.id, {
      recordId: rec.id, fromColumn: 'en', toColumn: 'fr', columnOrder: [rec.id]
    })
    const values = (await recordFields(opts, rec.id)).languages as string[]
    expect([...values].sort()).toEqual(['en', 'es', 'fr'])

    // Dropping on "No value" takes away only the column it left.
    await move(opts, view.id, {
      recordId: rec.id, fromColumn: 'en', toColumn: '', columnOrder: [rec.id]
    })
    const after = (await recordFields(opts, rec.id)).languages as string[]
    expect([...after].sort()).toEqual(['es', 'fr'])
  })

  it('a multi-user drag hands the card over: the source person is swapped for the target', async () => {
    const { org, auth, user } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const ana = await addViewsMember(sql, org.id)
    const ben = await addViewsMember(sql, org.id)
    const view = await createView(opts, { groupField: 'assigned_to' })
    const rec = await createContact(opts, { name: 'test-views Handover', assigned_to: [user.id, ana.user.id] })

    await move(opts, view.id, {
      recordId: rec.id, fromColumn: ana.user.id, toColumn: ben.user.id, columnOrder: [rec.id]
    })
    const assigned = (await recordFields(opts, rec.id)).assigned_to as string[]
    expect([...assigned].sort()).toEqual([user.id, ben.user.id].sort())
  })

  it('a stale fromColumn 409s instead of clobbering', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'status' })
    const rec = await createContact(opts, { name: 'test-views Stale', status: 'active' })

    await expect(move(opts, view.id, {
      recordId: rec.id, fromColumn: 'paused', toColumn: 'closed', columnOrder: [rec.id]
    })).rejects.toMatchObject({ statusCode: 409 })
    expect((await recordFields(opts, rec.id)).status).toBe('active')
  })

  it('reorders within a column by backfilling manual ranks', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'status' })
    const a = await createContact(opts, { name: 'test-views Rank A', status: 'new' })
    const b = await createContact(opts, { name: 'test-views Rank B', status: 'new' })

    // Drag b above a: same column, pure reorder — no field write.
    await move(opts, view.id, {
      recordId: b.id, fromColumn: 'new', toColumn: 'new', columnOrder: [b.id, a.id]
    })
    const res = await feed(opts, view.id)
    const ranks = new Map(res.placements
      .filter(p => p.columnKey === 'new')
      .map(p => [p.recordId, p.rank]))
    expect(ranks.get(b.id)).toBeTruthy()
    expect(ranks.get(a.id)).toBeTruthy()
    expect(ranks.get(b.id)! < ranks.get(a.id)!).toBe(true)
  })

  it('reordering within a column takes edit on the view, even for a caller who can edit the record', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await createView(owner, { groupField: 'status' })
    const a = await createContact(owner, { name: 'test-views Order A', status: 'new' })
    const b = await createContact(owner, { name: 'test-views Order B', status: 'new' })

    const roleName = await createViewsRole(sql, org.id, ['views.use', 'crm.access', 'crm.contacts.read', 'crm.contacts.view_all', 'crm.contacts.update'])
    const viewer = await createViewsUser(sql)
    await addTestMembership(sql, { user_id: viewer.id, org_id: org.id, roles: [roleName] })
    const viewerOpts = withOrgHeader(getAuthHeaders(viewer), org.slug)

    await expect(move(viewerOpts, view.id, {
      recordId: b.id, fromColumn: 'new', toColumn: 'new', columnOrder: [b.id, a.id]
    })).rejects.toMatchObject({ statusCode: 403 })
    expect((await feed(owner, view.id)).placements).toEqual([])

    // A drag to another column is a record edit, which the record's permissions decide.
    await move(viewerOpts, view.id, {
      recordId: b.id, fromColumn: 'new', toColumn: 'active', columnOrder: [b.id]
    })
    expect((await recordFields(owner, b.id)).status).toBe('active')
  })

  it('view access is not record access: a views-only caller cannot move', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await createView(owner, { groupField: 'status' })
    const rec = await createContact(owner, { name: 'test-views Guarded', status: 'new' })

    // view_all so the feed shows records the caller didn't create; no
    // update slug, so the drag's field write must be refused.
    const roleName = await createViewsRole(sql, org.id, ['views.use', 'crm.access', 'crm.contacts.read', 'crm.contacts.view_all'])
    const limited = await createViewsUser(sql)
    await addTestMembership(sql, { user_id: limited.id, org_id: org.id, roles: [roleName] })
    const limitedOpts = withOrgHeader(getAuthHeaders(limited), org.slug)

    // The org-wide view opens fine…
    const seen = await feed(limitedOpts, view.id)
    expect(seen.items.map(i => i.id)).toContain(rec.id)

    // …but the drag's field write dies on CRM's update permission.
    await expect(move(limitedOpts, view.id, {
      recordId: rec.id, fromColumn: 'new', toColumn: 'active', columnOrder: [rec.id]
    })).rejects.toMatchObject({ statusCode: 403 })
    expect((await recordFields(owner, rec.id)).status).toBe('new')
  })
})
