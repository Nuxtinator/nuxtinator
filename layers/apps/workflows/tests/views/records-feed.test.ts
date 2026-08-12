// The records feed's filter layering: the view's saved filters apply for
// every caller, a personal overlay narrows or replaces per key for this
// request only, and the grouping-field-missing marker fires when the
// definition points at a deleted field.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupWorkflowsTestData,
  createWorkflowsOrgWith,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupWorkflowsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Feed {
  items: Array<{ id: string, name: string }>
  total: number
  groupFieldMissing: boolean
}

async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/crm/records/contacts', {
    method: 'POST',
    body: { fields },
    ...opts
  })
}

describe('records feed', () => {
  it('layers personal filters over the view definition per key', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const active = await createContact(opts, { name: 'test-workflows Active EN', status: 'active', languages: ['en'] })
    const activeFr = await createContact(opts, { name: 'test-workflows Active FR', status: 'active', languages: ['fr'] })
    await createContact(opts, { name: 'test-workflows Paused', status: 'paused', languages: ['en'] })

    const view = await $fetch<{ id: string }>('/api/workflows/views', {
      method: 'POST',
      body: {
        name: 'test-workflows filtered',
        recordTypeKey: 'contacts',
        viewType: 'kanban',
        definition: { groupField: 'languages', filters: { status: 'active' } }
      },
      ...opts
    })

    // Saved filter alone: both active records, the paused one never shows.
    let res = await $fetch<Feed>(`/api/workflows/views/${view.id}/records`, opts)
    expect(res.items.map(i => i.id).sort()).toEqual([active.id, activeFr.id].sort())

    // Personal overlay narrows further without touching the saved filter.
    const personal = encodeURIComponent(JSON.stringify({ languages: 'fr' }))
    res = await $fetch<Feed>(`/api/workflows/views/${view.id}/records?filters=${personal}`, opts)
    expect(res.items.map(i => i.id)).toEqual([activeFr.id])

    // Overlay on the same key replaces the saved value for this caller.
    const override = encodeURIComponent(JSON.stringify({ status: 'paused' }))
    res = await $fetch<Feed>(`/api/workflows/views/${view.id}/records?filters=${override}`, opts)
    expect(res.items.map(i => i.name)).toEqual(['test-workflows Paused'])
  })

  it('flags a deleted grouping field instead of erroring', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    // A custom field on a custom type, grouped on, then deleted.
    await $fetch('/api/crm/schema/types', {
      method: 'POST',
      body: { typeKey: 'test_workflows_deals', label: 'Test Deals', labelSingular: 'Test Deal' },
      ...opts
    })
    await $fetch('/api/crm/schema/types/test_workflows_deals/fields', {
      method: 'POST',
      body: {
        fieldKey: 'stage',
        kind: 'key_select',
        label: 'Stage',
        options: { open: { label: 'Open' }, won: { label: 'Won' } }
      },
      ...opts
    })

    const view = await $fetch<{ id: string }>('/api/workflows/views', {
      method: 'POST',
      body: {
        name: 'test-workflows deals board',
        recordTypeKey: 'test_workflows_deals',
        viewType: 'kanban',
        definition: { groupField: 'stage' }
      },
      ...opts
    })

    await $fetch('/api/crm/schema/types/test_workflows_deals/fields/stage', { method: 'DELETE', ...opts })

    const res = await $fetch<Feed>(`/api/workflows/views/${view.id}/records`, opts)
    expect(res.groupFieldMissing).toBe(true)
    expect(res.items).toEqual([])
  })
})
