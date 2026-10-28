// Columns endpoints — global state, NOT tenant-scoped. Authenticated read for
// anyone; admin-only mutations (rename, reorder). All four columns
// (FEEDBACK INBOX, DOING, DONE, ARCHIVE) are mandatory and cannot be renamed,
// even by an operator admin.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  createFeedbackUser,
  getAuthHeaders,
  getColumnByName
} from '../helpers'

describe('feedback columns endpoints', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    // Restore canonical positions / collapse state — reorder and is_collapsed
    // mutations bleed across tests since columns is global state.
    await sql`UPDATE columns SET position = 1, is_collapsed = false WHERE name = 'FEEDBACK INBOX'`
    await sql`UPDATE columns SET position = 2, is_collapsed = false WHERE name = 'DISCUSS'`
    await sql`UPDATE columns SET position = 3, is_collapsed = false WHERE name = 'TODO'`
    await sql`UPDATE columns SET position = 4, is_collapsed = false WHERE name = 'DOING'`
    await sql`UPDATE columns SET position = 5, is_collapsed = false WHERE name = 'DONE'`
    await sql`UPDATE columns SET position = 6, is_collapsed = false WHERE name = 'ARCHIVE'`
    await cleanupFeedbackTestData(sql)
  })

  it('GET /api/feedback/columns: any authenticated user lists all columns', async () => {
    const { auth } = await createFeedbackOrgWith(sql, ['member'])
    const res = await $fetch<Array<{ id: string, name: string, position: number }>>('/api/feedback/columns', auth)
    // Migrations seed six columns.
    expect(res.length).toBe(6)
    expect(res[0]!.name).toBe('FEEDBACK INBOX')
    expect(res[res.length - 1]!.name).toBe('ARCHIVE')
  })

  it('GET /columns: 401 without auth', async () => {
    const err = await $fetch('/api/feedback/columns').catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('PATCH /:id: 400 attempting to rename a mandatory column', async () => {
    const adminUser = await createFeedbackUser(sql, { is_admin: true })
    const auth = getAuthHeaders(adminUser)
    const doing = await getColumnByName(sql, 'DOING')

    const err = await $fetch(`/api/feedback/columns/${doing.id}`, {
      method: 'PATCH',
      body: { name: 'NEWNAME' },
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('PATCH /:id: 404 when column not found', async () => {
    const adminUser = await createFeedbackUser(sql, { is_admin: true })
    const auth = getAuthHeaders(adminUser)
    const err = await $fetch('/api/feedback/columns/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      body: { is_collapsed: true },
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('PATCH /:id: 400 when no fields supplied', async () => {
    const adminUser = await createFeedbackUser(sql, { is_admin: true })
    const auth = getAuthHeaders(adminUser)
    const doing = await getColumnByName(sql, 'DOING')

    const err = await $fetch(`/api/feedback/columns/${doing.id}`, {
      method: 'PATCH',
      body: {},
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('PATCH /:id: is_collapsed toggle does NOT require operator admin (writes are gated only on rename)', async () => {
    const { auth } = await createFeedbackOrgWith(sql, ['admin'])
    const doing = await getColumnByName(sql, 'DOING')
    // No X-Active-Org header — this route is global, not org-scoped. Sending
    // an X-Active-Org would route through tenancy middleware which 404s on
    // unknown slugs.
    const res = await $fetch<{ is_collapsed: boolean }>(`/api/feedback/columns/${doing.id}`, {
      method: 'PATCH',
      body: { is_collapsed: true },
      ...auth
    })
    expect(res.is_collapsed).toBe(true)
    // restore handled by afterEach
  })

  it('PATCH /reorder: operator admin swaps two columns\' positions', async () => {
    const adminUser = await createFeedbackUser(sql, { is_admin: true })
    const auth = getAuthHeaders(adminUser)
    const doing = await getColumnByName(sql, 'DOING')
    const done = await getColumnByName(sql, 'DONE')

    const res = await $fetch<Array<{ id: string, name: string, position: number }>>(
      '/api/feedback/columns/reorder',
      {
        method: 'PATCH',
        body: { draggedColumnId: doing.id, targetColumnId: done.id },
        ...auth
      }
    )

    // Returned ordered by position; swapped pair now has its positions flipped.
    const doingRow = res.find(r => r.id === doing.id)
    const doneRow = res.find(r => r.id === done.id)
    expect(doingRow!.position).toBe(done.position)
    expect(doneRow!.position).toBe(doing.position)
    // restore handled by afterEach
  })

  it('PATCH /reorder: 400 without both ids', async () => {
    const adminUser = await createFeedbackUser(sql, { is_admin: true })
    const auth = getAuthHeaders(adminUser)
    const err = await $fetch('/api/feedback/columns/reorder', {
      method: 'PATCH',
      body: { draggedColumnId: 'x' },
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('PATCH /reorder: non-admin blocked', async () => {
    const { auth } = await createFeedbackOrgWith(sql, ['admin'])
    const doing = await getColumnByName(sql, 'DOING')
    const done = await getColumnByName(sql, 'DONE')
    const err = await $fetch('/api/feedback/columns/reorder', {
      method: 'PATCH',
      body: { draggedColumnId: doing.id, targetColumnId: done.id },
      ...auth
    }).catch(e => e)
    expect([401, 403]).toContain(err.statusCode)
  })
})
