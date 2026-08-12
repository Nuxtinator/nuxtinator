// Field-grouped board semantics through the records feed and move route:
// grouping values on the feed, the single-value write, the multi-value swap
// rule (drop the source column's value, keep the rest), the No-value
// column, manual ranks, staleness, and the CRM permission gate on moves.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupWorkflowsTestData,
  createWorkflowsOrgWith,
  addWorkflowsMember,
  createWorkflowsRole,
  createWorkflowsUser,
  addTestMembership,
  getAuthHeaders,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupWorkflowsTestData(sql) })

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
  return await $fetch<{ id: string }>('/api/workflows/views', {
    method: 'POST',
    body: {
      name: 'test-workflows move board',
      recordTypeKey: 'contacts',
      viewType: 'kanban',
      visibility: 'org',
      definition
    },
    ...opts
  })
}

async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/crm/records/contacts', {
    method: 'POST',
    body: { fields },
    ...opts
  })
}

async function feed(opts: Opts, viewId: string): Promise<Feed> {
  return await $fetch<Feed>(`/api/workflows/views/${viewId}/records`, opts)
}

async function move(opts: Opts, viewId: string, body: Record<string, unknown>): Promise<unknown> {
  return $fetch(`/api/workflows/views/${viewId}/move`, { method: 'POST', body, ...opts })
}

async function recordFields(opts: Opts, id: string): Promise<Record<string, unknown>> {
  const res = await $fetch<{ fields: Record<string, unknown> }>(`/api/crm/records/contacts/${id}`, opts)
  return res.fields
}

describe('field-grouped moves', () => {
  it('serves grouping values and writes a single-value move (and No value)', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'status' })
    const rec = await createContact(opts, { name: 'test-workflows Single', status: 'new' })

    let res = await feed(opts, view.id)
    expect(res.items.find(i => i.id === rec.id)?.groupValues).toEqual(['new'])

    await move(opts, view.id, {
      recordId: rec.id, fromColumn: 'new', toColumn: 'active', columnOrder: [rec.id]
    })
    expect((await recordFields(opts, rec.id)).status).toBe('active')

    // To the No-value column: the field empties.
    await move(opts, view.id, {
      recordId: rec.id, fromColumn: 'active', toColumn: '', columnOrder: [rec.id]
    })
    expect((await recordFields(opts, rec.id)).status).toBeNull()
    res = await feed(opts, view.id)
    expect(res.items.find(i => i.id === rec.id)?.groupValues).toEqual([])
  })

  it('multi-value drag swaps only the source column value and keeps the rest', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'languages' })
    const rec = await createContact(opts, {
      name: 'test-workflows Multi', languages: ['en', 'es']
    })

    // Dragged out of the 'en' column into 'fr': es survives, en goes.
    await move(opts, view.id, {
      recordId: rec.id, fromColumn: 'en', toColumn: 'fr', columnOrder: [rec.id]
    })
    const values = (await recordFields(opts, rec.id)).languages
    expect(values).toEqual(expect.arrayContaining(['es', 'fr']))
    expect(values).not.toContain('en')

    // From the No-value pseudo-source nothing is removed, the target adds.
    await move(opts, view.id, {
      recordId: rec.id, fromColumn: '', toColumn: 'ar', columnOrder: [rec.id]
    })
    const after = (await recordFields(opts, rec.id)).languages as string[]
    expect(after).toEqual(expect.arrayContaining(['es', 'fr', 'ar']))
  })

  it('a stale fromColumn 409s instead of clobbering', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'status' })
    const rec = await createContact(opts, { name: 'test-workflows Stale', status: 'active' })

    await expect(move(opts, view.id, {
      recordId: rec.id, fromColumn: 'paused', toColumn: 'closed', columnOrder: [rec.id]
    })).rejects.toMatchObject({ statusCode: 409 })
    expect((await recordFields(opts, rec.id)).status).toBe('active')
  })

  it('reorders within a column by backfilling manual ranks', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const view = await createView(opts, { groupField: 'status' })
    const a = await createContact(opts, { name: 'test-workflows Rank A', status: 'new' })
    const b = await createContact(opts, { name: 'test-workflows Rank B', status: 'new' })

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

  it('view access is not record access: a workflows-only caller cannot move', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const view = await createView(owner, { groupField: 'status' })
    const rec = await createContact(owner, { name: 'test-workflows Guarded', status: 'new' })

    // view_all so the feed shows records the caller didn't create; no
    // update slug, so the drag's field write must be refused.
    const roleName = await createWorkflowsRole(sql, org.id, ['workflows.use', 'crm.access', 'crm.contacts.read', 'crm.contacts.view_all'])
    const limited = await createWorkflowsUser(sql)
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
