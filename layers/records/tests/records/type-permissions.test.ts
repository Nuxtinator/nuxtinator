// The per-type permission evaluator (override-with-fallback), exercised
// through the records + schema routes: a roleGrants row on the type's
// records_types config IS the role's answer in either direction; no row
// falls back to the role's own slugs; direct user grants are additive and
// pass through untouched; admin bypasses everything; multiple roles OR.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  createTestContact,
  withOrgHeader
} from '../helpers'

type SqlClient = ReturnType<typeof postgres>

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

// Seed a per-type roleGrants map directly on the records_types row —
// phase 3 adds the HTTP surface; the storage contract is the row's config.
// Bound through ::text::jsonb — postgres-js double-encodes a pre-stringified
// param bound with a bare ::jsonb cast (dev.md gotcha 1).
async function setRoleGrants(
  db: SqlClient,
  orgId: string,
  typeKey: string,
  roleGrants: Record<string, Record<string, boolean>>
): Promise<void> {
  const config = JSON.stringify({ roleGrants })
  const rows = await db`
    SELECT id, config FROM records_types WHERE org_id = ${orgId} AND type_key = ${typeKey}
  `
  if (rows.length > 0) {
    await db`
      UPDATE records_types SET config = config || ${config}::text::jsonb WHERE id = ${rows[0]!.id}
    `
  } else {
    await db`
      INSERT INTO records_types (id, type_key, config, is_custom, org_id)
      VALUES (${randomUUID()}, ${typeKey}, ${config}::text::jsonb, false, ${orgId})
    `
  }
}

async function grantPermission(db: SqlClient, orgId: string, userId: string, permission: string): Promise<void> {
  await db`
    INSERT INTO user_permission_grants (id, user_id, permission, org_id)
    VALUES (${randomUUID()}, ${userId}, ${permission}, ${orgId})
  `
}

async function createCustomRole(db: SqlClient, orgId: string, permissions: string[]): Promise<string> {
  const name = `test-records-role-${randomUUID().slice(0, 8)}`
  await db`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'evaluator test role', ${permissions}::text[], ${orgId})
  `
  return name
}

interface TypesResponse {
  types: Array<{ key: string, canRead: boolean, canCreate: boolean }>
}

describe('per-type role grants (override-with-fallback)', () => {
  it('a row false overrides the role slug; no row falls back to it; the type drops from the types GET', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])
    const memberOpts = withOrgHeader(member.auth, org.slug)

    // Fallback baseline: member holds crm.contacts.read via default grants.
    const before = await $fetch<{ total: number }>('/api/records/entries/contacts', memberOpts)
    expect(before.total).toBe(0)

    await setRoleGrants(sql, org.id, 'contacts', { member: { read: false } })

    const denied = await $fetch('/api/records/entries/contacts', memberOpts).catch(e => e)
    expect(denied.statusCode).toBe(403)
    // The 403 names the denied slug.
    expect(String(denied.data?.statusMessage ?? denied.message)).toContain('crm.contacts.read')

    // The types GET reflects the same decision — non-readable types drop out
    // for non-schema-managers.
    const memberTypes = await $fetch<TypesResponse>('/api/records/schema/types', memberOpts)
    expect(memberTypes.types.find(t => t.key === 'contacts')).toBeUndefined()

    // Schema managers keep the entry (the builder needs it), flagged honestly.
    const adminTypes = await $fetch<TypesResponse>('/api/records/schema/types', withOrgHeader(auth, org.slug))
    expect(adminTypes.types.find(t => t.key === 'contacts')).toMatchObject({ canRead: true, canCreate: true })
  })

  it('a row true grants an action the role has no slug for', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])
    const memberOpts = withOrgHeader(member.auth, org.slug)

    // Not shared, not assigned — invisible to a member without view_all.
    await createTestContact(sql, { org_id: org.id, created_by: user.id, name: 'test-records Unshared' })

    const before = await $fetch<{ total: number }>('/api/records/entries/contacts', memberOpts)
    expect(before.total).toBe(0)

    // member's default grants carry no crm.contacts.view_all slug; the row
    // grants it anyway.
    await setRoleGrants(sql, org.id, 'contacts', { member: { view_all: true } })

    const after = await $fetch<{ total: number }>('/api/records/entries/contacts', memberOpts)
    expect(after.total).toBe(1)
  })

  it('a direct user grant bypasses a role row false', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])
    const memberOpts = withOrgHeader(member.auth, org.slug)

    const contact = await createTestContact(sql, { org_id: org.id, created_by: user.id, name: 'test-records Assigned' })
    await sql`
      INSERT INTO records_user_refs (record_id, field_key, user_id, org_id)
      VALUES (${contact.id}, 'assigned_to', ${member.user.id}, ${org.id})
    `

    await setRoleGrants(sql, org.id, 'contacts', { member: { update: false } })

    const denied = await $fetch(`/api/records/entries/contacts/${contact.id}`, {
      method: 'PATCH',
      body: { fields: { nickname: 'Nope' } },
      ...memberOpts
    }).catch(e => e)
    expect(denied.statusCode).toBe(403)

    // Personal grants are slug-level and additive — a role-keyed row can
    // never subtract them.
    await grantPermission(sql, org.id, member.user.id, 'crm.contacts.update')

    const patched = await $fetch<{ fields: Record<string, unknown> }>(`/api/records/entries/contacts/${contact.id}`, {
      method: 'PATCH',
      body: { fields: { nickname: 'Yep' } },
      ...memberOpts
    })
    expect(patched.fields.nickname).toBe('Yep')
  })

  it('admin bypasses row denies', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await setRoleGrants(sql, org.id, 'contacts', { admin: { read: false, create: false } })

    const list = await $fetch<{ total: number }>('/api/records/entries/contacts', opts)
    expect(list.total).toBe(0)
    const created = await $fetch<{ id: string }>('/api/records/entries/contacts', {
      method: 'POST',
      body: { fields: { name: 'test-records Admin Wins' } },
      ...opts
    })
    expect(created.id).toBeTruthy()
  })

  it('multiple roles OR: a second role answers when the first is row-denied', async () => {
    const { org } = await createRecordsOrgWith(sql, ['admin'])
    const roleName = await createCustomRole(sql, org.id, ['crm.access', 'crm.contacts.read'])
    const dual = await addRecordsMember(sql, org.id, ['member', roleName])
    const dualOpts = withOrgHeader(dual.auth, org.slug)

    await setRoleGrants(sql, org.id, 'contacts', { member: { read: false } })

    // member says no (row), the custom role says yes (slug fallback) → allowed.
    const list = await $fetch<{ total: number }>('/api/records/entries/contacts', dualOpts)
    expect(list.total).toBe(0)
  })

  it('capability flags mirror the evaluator decisions', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])
    const memberOpts = withOrgHeader(member.auth, org.slug)

    const contact = await createTestContact(sql, { org_id: org.id, created_by: user.id, name: 'test-records Flags' })
    await sql`
      INSERT INTO records_user_refs (record_id, field_key, user_id, org_id)
      VALUES (${contact.id}, 'assigned_to', ${member.user.id}, ${org.id})
    `
    await setRoleGrants(sql, org.id, 'contacts', { member: { update: false, create: false } })

    const detail = await $fetch<{ capabilities: { canEdit: boolean, canShare: boolean, canDelete: boolean } }>(
      `/api/records/entries/contacts/${contact.id}`, memberOpts
    )
    // update row-denied; share via slug fallback; delete has no member slug.
    expect(detail.capabilities).toEqual({ canEdit: false, canShare: true, canDelete: false })

    const types = await $fetch<TypesResponse>('/api/records/schema/types', memberOpts)
    expect(types.types.find(t => t.key === 'contacts')).toMatchObject({ canRead: true, canCreate: false })
  })
})
