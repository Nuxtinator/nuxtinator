// The default status every type without a code-declared one gets: Open / Done
// on admin-created types and items, closing through Done, the open/closed
// option guard, always shown, and unset statuses reading as the default.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  withOrgHeader
} from '../helpers'

interface FieldEntry {
  key: string
  kind: string
  column: string | null
  hidden: boolean
  options: Record<string, { label: string, closed?: boolean, deleted?: boolean }> | null
  custom: boolean
}

interface FieldsResponse {
  statusField: string | null
  fields: FieldEntry[]
}

interface ListResponse {
  items: Array<{ id: string, name: string, status: string | null }>
  total: number
}

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

async function createProjectsType(opts: Opts): Promise<void> {
  await $fetch('/api/records/schema/types', {
    method: 'POST',
    body: { typeKey: 'projects', label: 'Projects', labelSingular: 'Project' },
    ...opts
  })
}

describe('default status field', () => {
  it('gives an admin-created type an Open / Done status', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createProjectsType(opts)

    const res = await $fetch<FieldsResponse>('/api/records/schema/types/projects/fields', opts)
    expect(res.statusField).toBe('status')
    const status = res.fields.find(f => f.key === 'status')!
    expect(status).toMatchObject({ kind: 'key_select', column: 'status', custom: false })
    expect(Object.keys(status.options ?? {})).toEqual(['open', 'done'])
    expect(status.options!.done!.closed).toBe(true)
  })

  it('gives the item type a status and keeps the task and contact ones', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const item = await $fetch<FieldsResponse>('/api/records/schema/types/item/fields', opts)
    expect(item.statusField).toBe('status')
    expect(Object.keys(item.fields.find(f => f.key === 'status')!.options ?? {})).toEqual(['open', 'done'])

    const contacts = await $fetch<FieldsResponse>('/api/records/schema/types/contacts/fields', opts)
    expect(Object.keys(contacts.fields.find(f => f.key === 'status')!.options ?? {})).toContain('active')
    expect(contacts.fields.filter(f => f.column === 'status')).toHaveLength(1)
  })

  it('starts records Open and closes them with Done', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createProjectsType(opts)

    const created = await $fetch<{ id: string, status: string }>('/api/records/entries/projects', {
      method: 'POST', body: { fields: { name: 'test-records P' } }, ...opts
    })
    expect(created.status).toBe('open')

    await $fetch(`/api/records/entries/projects/${created.id}`, {
      method: 'PATCH', body: { fields: { status: 'done' } }, ...opts
    })
    const closedOut = await $fetch<ListResponse>('/api/records/entries/projects', opts)
    expect(closedOut.items.find(i => i.id === created.id)?.status).toBe('done')
  })

  it('reads, filters and sorts an unset status as the default', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createProjectsType(opts)
    const created = await $fetch<{ id: string }>('/api/records/entries/projects', {
      method: 'POST', body: { fields: { name: 'test-records Old' } }, ...opts
    })
    await sql`UPDATE records_entries SET status = NULL WHERE id = ${created.id}`

    const one = await $fetch<{ status: string, fields: Record<string, unknown> }>(
      `/api/records/entries/projects/${created.id}`, opts
    )
    expect(one.status).toBe('open')
    expect(one.fields.status).toBe('open')

    const filtered = await $fetch<ListResponse>(
      `/api/records/entries/projects?filters=${encodeURIComponent(JSON.stringify({ status: 'open' }))}`, opts
    )
    expect(filtered.items.map(i => i.id)).toEqual([created.id])
    expect(filtered.items[0]!.status).toBe('open')
  })

  it('keeps at least one open and one closed option', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createProjectsType(opts)
    const url = '/api/records/schema/types/projects/fields/status'

    const noClosed = await $fetch(url, {
      method: 'PATCH', body: { options: { done: { label: 'Done', deleted: true } } }, ...opts
    }).catch(e => e)
    expect(noClosed.statusCode).toBe(400)

    const noOpen = await $fetch(url, {
      method: 'PATCH', body: { options: { open: { label: 'Open', closed: true } } }, ...opts
    }).catch(e => e)
    expect(noOpen.statusCode).toBe(400)

    // Adding another closed option first makes removing Done fine.
    const ok = await $fetch<{ field: FieldEntry }>(url, {
      method: 'PATCH',
      body: { options: { wont_do: { label: "Won't do", closed: true }, done: { label: 'Done', deleted: true } } },
      ...opts
    })
    expect(ok.field.options!.wont_do!.closed).toBe(true)
    expect(ok.field.options!.done!.deleted).toBe(true)
  })

  it('refuses to hide the status field', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const hidden = await $fetch('/api/records/schema/types/task/fields/status', {
      method: 'PATCH', body: { hidden: true }, ...opts
    }).catch(e => e)
    expect(hidden.statusCode).toBe(400)
  })

  it('starts new records in the first open option when the default is removed', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createProjectsType(opts)
    await $fetch('/api/records/schema/types/projects/fields/status', {
      method: 'PATCH',
      body: { options: { open: { label: 'Open', deleted: true }, todo: { label: 'To do' } } },
      ...opts
    })

    const created = await $fetch<{ status: string }>('/api/records/entries/projects', {
      method: 'POST', body: { fields: { name: 'test-records New' } }, ...opts
    })
    expect(created.status).toBe('todo')
  })
})
