// The records feed's filter layering: the view's base filter applies on
// every tab, each tab's own filter narrows it, a text search narrows for this
// request only, and the grouping-field-missing marker fires when a tab points
// at a deleted field.
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
  total: number
  groupFieldMissing: boolean
}

async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields },
    ...opts
  })
}

describe('records feed', () => {
  it('a tab narrows its view\'s filter; tabs of one view show different slices', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const active = await createContact(opts, { name: 'test-views Active EN', status: 'active', languages: ['en'] })
    const activeFr = await createContact(opts, { name: 'test-views Active FR', status: 'active', languages: ['fr'] })
    await createContact(opts, { name: 'test-views Paused', status: 'paused', languages: ['en'] })

    const view = await $fetch<{ id: string, tabs: Array<{ id: string }> }>('/api/views', {
      method: 'POST',
      body: {
        name: 'test-views filtered',
        recordTypeKey: 'contacts',
        definition: { filter: { match: 'all', rules: [{ field: 'status', op: 'is', value: 'active' }] } },
        tab: { layout: 'kanban', definition: { groupField: 'languages' } }
      },
      ...opts
    })
    const french = await $fetch<{ id: string }>(`/api/views/${view.id}/tabs`, {
      method: 'POST',
      body: {
        name: 'French',
        layout: 'list',
        definition: { filter: { match: 'all', rules: [{ field: 'languages', op: 'any_of', value: ['fr'] }] } }
      },
      ...opts
    })

    // The base filter alone: both active records, the paused one never shows.
    let res = await $fetch<Feed>(`/api/views/${view.id}/records`, opts)
    expect(res.items.map(i => i.id).sort()).toEqual([active.id, activeFr.id].sort())

    // The second tab narrows the base filter, never widens it.
    res = await $fetch<Feed>(`/api/views/${view.id}/records?tab=${french.id}`, opts)
    expect(res.items.map(i => i.id)).toEqual([activeFr.id])

    // A search narrows for this request without touching either filter.
    res = await $fetch<Feed>(`/api/views/${view.id}/records?tab=${view.tabs[0]!.id}&q=EN`, opts)
    expect(res.items.map(i => i.id)).toEqual([active.id])

    // A tab of another view is not this view's tab.
    const other = await $fetch<{ tabs: Array<{ id: string }> }>('/api/views', {
      method: 'POST',
      body: { name: 'test-views other', recordTypeKey: 'contacts', tab: { layout: 'table' } },
      ...opts
    })
    await expect($fetch(`/api/views/${view.id}/records?tab=${other.tabs[0]!.id}`, opts))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('flags a deleted grouping field instead of erroring', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    // A custom field on a custom type, grouped on, then deleted.
    await $fetch('/api/records/schema/types', {
      method: 'POST',
      body: { typeKey: 'test_views_deals', label: 'Test Deals', labelSingular: 'Test Deal' },
      ...opts
    })
    await $fetch('/api/records/schema/types/test_views_deals/fields', {
      method: 'POST',
      body: {
        fieldKey: 'stage',
        kind: 'key_select',
        label: 'Stage',
        options: { open: { label: 'Open' }, won: { label: 'Won' } }
      },
      ...opts
    })

    const view = await $fetch<{ id: string }>('/api/views', {
      method: 'POST',
      body: {
        name: 'test-views deals board',
        recordTypeKey: 'test_views_deals',
        tab: { layout: 'kanban', definition: { groupField: 'stage' } }
      },
      ...opts
    })

    await $fetch('/api/records/schema/types/test_views_deals/fields/stage', { method: 'DELETE', ...opts })

    const res = await $fetch<Feed>(`/api/views/${view.id}/records`, opts)
    expect(res.groupFieldMissing).toBe(true)
    expect(res.items).toEqual([])
  })
})
