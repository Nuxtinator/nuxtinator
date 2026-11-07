// Share levels through the share + record routes: level round-trips on the
// shares feed, re-sharing upserts the level, and an edit-level share grants
// record-scoped update (field patch) to a user with no crm slugs at all —
// while view shares stay read-only and delete stays type-level. Commenting
// takes the type's read, like reading the thread.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

type SqlClient = ReturnType<typeof postgres>
type Opts = ReturnType<typeof withOrgHeader>

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

interface ShareEntry {
  userId: string
  level: 'view' | 'edit'
}

async function createPermlessRole(db: SqlClient, orgId: string): Promise<string> {
  const name = `test-records-permless-${randomUUID().slice(0, 8)}`
  await db`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'no perms for tests', '{}'::text[], ${orgId})
  `
  return name
}

async function createContact(opts: Opts, name: string): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields: { name } },
    ...opts
  })
}

async function share(opts: Opts, recordId: string, userId: string, level?: 'view' | 'edit'): Promise<ShareEntry[]> {
  const res = await $fetch<{ items: ShareEntry[] }>(`/api/records/entries/contacts/${recordId}/shares`, {
    method: 'POST',
    body: level ? { userId, level } : { userId },
    ...opts
  })
  return res.items
}

describe('share levels', () => {
  it('defaults to view, round-trips on the feed, and upserts on re-share', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const rec = await createContact(adminOpts, 'test-records Leveled')

    let items = await share(adminOpts, rec.id, member.user.id)
    expect(items.find(s => s.userId === member.user.id)).toMatchObject({ level: 'view' })

    // Re-sharing with a new level updates the row instead of duplicating it.
    items = await share(adminOpts, rec.id, member.user.id, 'edit')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ level: 'edit' })

    const viaGet = await $fetch<{ items: ShareEntry[] }>(
      `/api/records/entries/contacts/${rec.id}/shares`, adminOpts
    )
    expect(viaGet.items[0]).toMatchObject({ level: 'edit' })
  })

  it('an edit share grants a slug-less user update on exactly that record; view does not; delete never', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const roleName = await createPermlessRole(sql, org.id)
    const outsider = await addRecordsMember(sql, org.id, [roleName])
    const adminOpts = withOrgHeader(auth, org.slug)
    const outsiderOpts = withOrgHeader(outsider.auth, org.slug)

    const editable = await createContact(adminOpts, 'test-records Editable')
    const viewable = await createContact(adminOpts, 'test-records Viewable')
    const invisible = await createContact(adminOpts, 'test-records Invisible')
    await share(adminOpts, editable.id, outsider.user.id, 'edit')
    await share(adminOpts, viewable.id, outsider.user.id, 'view')

    // Edit share → the field patch and the comment both land.
    const patched = await $fetch<{ fields: Record<string, unknown>, capabilities: { canEdit: boolean, canDelete: boolean } }>(
      `/api/records/entries/contacts/${editable.id}`,
      { method: 'PATCH', body: { fields: { nickname: 'Shared pen' } }, ...outsiderOpts }
    )
    expect(patched.fields.nickname).toBe('Shared pen')
    expect(patched.capabilities.canEdit).toBe(true)
    expect(patched.capabilities.canDelete).toBe(false)

    const commentDenied = await $fetch(
      `/api/records/entries/contacts/${editable.id}/comments`,
      { method: 'POST', body: { body: 'test-records edit-share comment' }, ...outsiderOpts }
    ).catch(e => e)
    expect(commentDenied.statusCode).toBe(403)

    // View share → visible but read-only.
    const viewDenied = await $fetch(`/api/records/entries/contacts/${viewable.id}`, {
      method: 'PATCH',
      body: { fields: { nickname: 'Nope' } },
      ...outsiderOpts
    }).catch(e => e)
    expect(viewDenied.statusCode).toBe(403)
    // With the type's read, a view share is enough to comment.
    const reader = await addRecordsMember(sql, org.id, ['member'])
    await share(adminOpts, viewable.id, reader.user.id, 'view')
    const viewComment = await $fetch<{ id: string }>(
      `/api/records/entries/contacts/${viewable.id}/comments`,
      { method: 'POST', body: { body: 'test-records view-share comment' }, ...withOrgHeader(reader.auth, org.slug) }
    )
    expect(viewComment.id).toBeTruthy()

    // No share → not even visible.
    const invisibleDenied = await $fetch(`/api/records/entries/contacts/${invisible.id}`, {
      method: 'PATCH',
      body: { fields: { nickname: 'Nope' } },
      ...outsiderOpts
    }).catch(e => e)
    expect(invisibleDenied.statusCode).toBe(404)

    // Delete stays type-level — an edit share never grants it.
    const deleteDenied = await $fetch(`/api/records/entries/contacts/${editable.id}`, {
      method: 'DELETE',
      ...outsiderOpts
    }).catch(e => e)
    expect(deleteDenied.statusCode).toBe(403)
  })

  it('capability flags reflect the share level on the detail response', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const roleName = await createPermlessRole(sql, org.id)
    const outsider = await addRecordsMember(sql, org.id, [roleName])
    const adminOpts = withOrgHeader(auth, org.slug)
    const outsiderOpts = withOrgHeader(outsider.auth, org.slug)

    const rec = await createContact(adminOpts, 'test-records Cap Flags')
    await share(adminOpts, rec.id, outsider.user.id, 'view')

    // The read gate itself is slug-driven, so the slug-less outsider can't
    // even GET the detail — capabilities are only reachable once read passes.
    const noRead = await $fetch(`/api/records/entries/contacts/${rec.id}`, outsiderOpts).catch(e => e)
    expect(noRead.statusCode).toBe(403)

    // A member (read via default grants) sees the flags flip with the level.
    const member = await addRecordsMember(sql, org.id, ['member'])
    const memberOpts = withOrgHeader(member.auth, org.slug)
    // ::text::jsonb — postgres-js double-encodes a pre-stringified param
    // bound with a bare ::jsonb cast (dev.md gotcha 1).
    await sql`
      INSERT INTO records_types (id, type_key, config, is_custom, org_id)
      VALUES (${randomUUID()}, 'contacts', ${JSON.stringify({ roleGrants: { member: { update: false } } })}::text::jsonb, false, ${org.id})
    `
    await share(adminOpts, rec.id, member.user.id, 'view')
    let detail = await $fetch<{ capabilities: { canEdit: boolean } }>(
      `/api/records/entries/contacts/${rec.id}`, memberOpts
    )
    expect(detail.capabilities.canEdit).toBe(false)

    await share(adminOpts, rec.id, member.user.id, 'edit')
    detail = await $fetch<{ capabilities: { canEdit: boolean } }>(
      `/api/records/entries/contacts/${rec.id}`, memberOpts
    )
    expect(detail.capabilities.canEdit).toBe(true)
  })
})
