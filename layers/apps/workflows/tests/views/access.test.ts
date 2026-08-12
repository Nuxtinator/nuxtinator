// The view access matrix through the routes: private / shared / org
// visibility crossed with owner / share levels / stranger / org-admin, plus
// the admin governance endpoints.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupWorkflowsTestData,
  createWorkflowsOrgWith,
  addWorkflowsMember,
  addTestMembership,
  createWorkflowsUser,
  getAuthHeaders,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupWorkflowsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface ViewDetail {
  id: string
  name: string
  visibility: string
  accessLevel: 'view' | 'edit' | 'owner'
  definition: Record<string, unknown>
}

async function createView(opts: Opts, body: Record<string, unknown> = {}): Promise<ViewDetail> {
  return await $fetch<ViewDetail>('/api/workflows/views', {
    method: 'POST',
    body: {
      name: 'test-workflows board',
      recordTypeKey: 'contacts',
      viewType: 'kanban',
      definition: { groupField: 'status' },
      ...body
    },
    ...opts
  })
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ statusCode: status })
}

describe('view access matrix', () => {
  it('private views exist only for their owner', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const stranger = withOrgHeader((await addWorkflowsMember(sql, org.id)).auth, org.slug)

    const view = await createView(owner)
    expect(view.accessLevel).toBe('owner')

    const mine = await $fetch<{ items: ViewDetail[] }>('/api/workflows/views', owner)
    expect(mine.items.map(v => v.id)).toContain(view.id)

    const theirs = await $fetch<{ items: ViewDetail[] }>('/api/workflows/views', stranger)
    expect(theirs.items.map(v => v.id)).not.toContain(view.id)

    await expectStatus($fetch(`/api/workflows/views/${view.id}`, stranger), 404)
  })

  it('org visibility grants view (not edit) to everyone in the org', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const member = withOrgHeader((await addWorkflowsMember(sql, org.id)).auth, org.slug)

    const view = await createView(owner, { visibility: 'org' })

    const got = await $fetch<ViewDetail>(`/api/workflows/views/${view.id}`, member)
    expect(got.accessLevel).toBe('view')

    await expectStatus($fetch(`/api/workflows/views/${view.id}`, {
      method: 'PATCH',
      body: { name: 'renamed' },
      ...member
    }), 403)

    const renamed = await $fetch<ViewDetail>(`/api/workflows/views/${view.id}`, {
      method: 'PATCH',
      body: { name: 'renamed by owner' },
      ...owner
    })
    expect(renamed.name).toBe('renamed by owner')
  })

  it('shares grant their level, only while visibility is not private', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const owner = withOrgHeader(auth, org.slug)
    const invitee = await addWorkflowsMember(sql, org.id)
    const inviteeOpts = withOrgHeader(invitee.auth, org.slug)

    // Share on a private view: dormant.
    const view = await createView(owner)
    await $fetch(`/api/workflows/views/${view.id}/shares`, {
      method: 'POST',
      body: { userId: invitee.user.id, level: 'view' },
      ...owner
    })
    await expectStatus($fetch(`/api/workflows/views/${view.id}`, inviteeOpts), 404)

    // Flip to shared: the share applies at its level.
    await $fetch(`/api/workflows/views/${view.id}`, {
      method: 'PATCH',
      body: { visibility: 'shared' },
      ...owner
    })
    const seen = await $fetch<ViewDetail>(`/api/workflows/views/${view.id}`, inviteeOpts)
    expect(seen.accessLevel).toBe('view')
    await expectStatus($fetch(`/api/workflows/views/${view.id}`, {
      method: 'PATCH',
      body: { definition: { groupField: 'gender' } },
      ...inviteeOpts
    }), 403)

    // Re-share at edit: definition becomes editable, visibility stays owner-only.
    await $fetch(`/api/workflows/views/${view.id}/shares`, {
      method: 'POST',
      body: { userId: invitee.user.id, level: 'edit' },
      ...owner
    })
    const edited = await $fetch<ViewDetail>(`/api/workflows/views/${view.id}`, {
      method: 'PATCH',
      body: { definition: { groupField: 'gender' } },
      ...inviteeOpts
    })
    expect(edited.definition.groupField).toBe('gender')
    await expectStatus($fetch(`/api/workflows/views/${view.id}`, {
      method: 'PATCH',
      body: { visibility: 'org' },
      ...inviteeOpts
    }), 403)

    // Removing the share cuts access entirely.
    await $fetch(`/api/workflows/views/${view.id}/shares/${invitee.user.id}`, {
      method: 'DELETE',
      ...owner
    })
    await expectStatus($fetch(`/api/workflows/views/${view.id}`, inviteeOpts), 404)
  })

  it('delete is owner-only, and the org admin role counts as owner', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const orgAdmin = withOrgHeader((await addWorkflowsMember(sql, org.id, ['admin'])).auth, org.slug)
    const member = withOrgHeader((await addWorkflowsMember(sql, org.id)).auth, org.slug)

    const view = await createView(owner, { visibility: 'org' })
    await expectStatus($fetch(`/api/workflows/views/${view.id}`, { method: 'DELETE', ...member }), 403)

    await $fetch(`/api/workflows/views/${view.id}`, { method: 'DELETE', ...orgAdmin })
    await expectStatus($fetch(`/api/workflows/views/${view.id}`, owner), 404)
  })
})

describe('admin governance', () => {
  it('operator admin lists every view, reassigns owners, and deletes', async () => {
    const { org, auth, user } = await createWorkflowsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)

    const operator = await createWorkflowsUser(sql, { is_admin: true })
    await addTestMembership(sql, { user_id: operator.id, org_id: org.id, roles: ['member'] })
    const operatorOpts = withOrgHeader(getAuthHeaders(operator), org.slug)

    const view = await createView(owner)

    const listed = await $fetch<{ items: Array<{ id: string, ownerId: string }> }>(
      '/api/workflows/admin/views', operatorOpts)
    const row = listed.items.find(v => v.id === view.id)
    expect(row).toBeDefined()
    expect(row!.ownerId).toBe(user.id)

    await $fetch(`/api/workflows/admin/views/${view.id}/owner`, {
      method: 'PATCH',
      body: { userId: operator.id },
      ...operatorOpts
    })
    const mine = await $fetch<{ items: Array<{ id: string, accessLevel: string }> }>(
      '/api/workflows/views', operatorOpts)
    expect(mine.items.find(v => v.id === view.id)?.accessLevel).toBe('owner')

    await $fetch(`/api/workflows/admin/views/${view.id}`, { method: 'DELETE', ...operatorOpts })
    await expectStatus($fetch(`/api/workflows/views/${view.id}`, operatorOpts), 404)
  })

  it('non-operators are refused', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await expectStatus($fetch('/api/workflows/admin/views', opts), 403)
  })
})
