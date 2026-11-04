// The role-grants admin routes: GET returns the matrix view (assignable
// roles, stored grants, per-role effective answers with source + fallback);
// PUT full-replaces the type's grants after validating role names against
// the real role set (static + custom) and rejecting 'admin'; the effective
// map matches what the evaluator actually enforces on the record routes.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  addCrmMember,
  withOrgHeader
} from '../helpers'

type SqlClient = ReturnType<typeof postgres>
type Opts = ReturnType<typeof withOrgHeader>

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

async function createCustomRole(db: SqlClient, orgId: string, permissions: string[]): Promise<string> {
  const name = `test-crm-role-${randomUUID().slice(0, 8)}`
  await db`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'role-grants test role', ${permissions}::text[], ${orgId})
  `
  return name
}

interface EffectiveCell {
  allowed: boolean
  source: 'row' | 'slug' | 'admin'
  fallback: boolean
}

interface RoleGrantsView {
  actions: string[]
  roles: Array<{ key: string, label: string, custom: boolean }>
  grants: Record<string, Record<string, boolean>>
  effective: Record<string, Record<string, EffectiveCell>>
}

function getView(opts: Opts, typeKey = 'contacts'): Promise<RoleGrantsView> {
  return $fetch<RoleGrantsView>(`/api/crm/schema/types/${typeKey}/role-grants`, opts)
}

function putGrants(opts: Opts, grants: Record<string, Record<string, boolean>>, typeKey = 'contacts'): Promise<RoleGrantsView> {
  return $fetch<RoleGrantsView>(`/api/crm/schema/types/${typeKey}/role-grants`, {
    method: 'PUT',
    body: { grants },
    ...opts
  })
}

describe('role-grants routes', () => {
  it('GET returns actions, the role directory, and slug-fallback effective answers', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const roleName = await createCustomRole(sql, org.id, ['crm.access', 'crm.contacts.read'])
    const opts = withOrgHeader(auth, org.slug)

    const view = await getView(opts)
    expect(view.actions).toEqual(['read', 'create', 'update', 'delete', 'share', 'view_all'])
    expect(view.grants).toEqual({})

    // Static roles first (admin included), custom roles flagged.
    expect(view.roles.find(r => r.key === 'admin')).toMatchObject({ custom: false })
    expect(view.roles.find(r => r.key === 'member')).toMatchObject({ custom: false })
    expect(view.roles.find(r => r.key === roleName)).toMatchObject({ custom: true })

    // Admin cells are the bypass, not slugs or rows.
    expect(view.effective.admin!.read).toMatchObject({ allowed: true, source: 'admin' })
    // member's default grants carry read but not delete — pure slug fallback.
    expect(view.effective.member!.read).toEqual({ allowed: true, source: 'slug', fallback: true })
    expect(view.effective.member!.delete).toEqual({ allowed: false, source: 'slug', fallback: false })
    // The custom role's own slug set answers per role, not the caller's perms.
    expect(view.effective[roleName]!.read).toEqual({ allowed: true, source: 'slug', fallback: true })
    expect(view.effective[roleName]!.update).toEqual({ allowed: false, source: 'slug', fallback: false })
  })

  it('is gated on crm.schema.manage', async () => {
    const { org } = await createCrmOrgWith(sql, ['admin'])
    const member = await addCrmMember(sql, org.id, ['member'])
    const denied = await getView(withOrgHeader(member.auth, org.slug)).catch(e => e)
    expect(denied.statusCode).toBe(403)
  })

  it('PUT stores explicit rows whose effective answers match route enforcement', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const member = await addCrmMember(sql, org.id, ['member'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const memberOpts = withOrgHeader(member.auth, org.slug)

    const view = await putGrants(adminOpts, { member: { read: false, view_all: true } })
    expect(view.grants).toEqual({ member: { read: false, view_all: true } })
    // Row false beats the present read slug; row true beats the missing
    // view_all slug; fallback still reports the slug answer underneath.
    expect(view.effective.member!.read).toEqual({ allowed: false, source: 'row', fallback: true })
    expect(view.effective.member!.view_all).toEqual({ allowed: true, source: 'row', fallback: false })
    expect(view.effective.member!.update).toMatchObject({ source: 'slug' })

    // The map is honest: the records route enforces exactly that answer.
    const denied = await $fetch('/api/crm/records/contacts', memberOpts).catch(e => e)
    expect(denied.statusCode).toBe(403)

    // Full replacement: an empty map clears every row and the override row
    // itself (contacts carries nothing else), restoring slug fallback.
    const cleared = await putGrants(adminOpts, {})
    expect(cleared.grants).toEqual({})
    expect(cleared.effective.member!.read).toEqual({ allowed: true, source: 'slug', fallback: true })
    const rows = await sql`
      SELECT id FROM crm_record_types WHERE org_id = ${org.id} AND type_key = 'contacts'
    `
    expect(rows.length).toBe(0)

    const listed = await $fetch<{ total: number }>('/api/crm/records/contacts', memberOpts)
    expect(listed.total).toBe(0)
  })

  it('PUT by a non-admin can only add true rows for actions the caller holds', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const designer = await addCrmMember(sql, org.id, ['member'])
    await $fetch('/api/crm/schema/user-grants', {
      method: 'POST',
      body: { userId: designer.user.id, permission: 'crm.schema.manage' },
      ...withOrgHeader(auth, org.slug)
    })
    const designerOpts = withOrgHeader(designer.auth, org.slug)
    const viewer = await createCustomRole(sql, org.id, [])
    const other = await createCustomRole(sql, org.id, [])

    // Member's own slugs carry read but not view_all.
    const escalate = await putGrants(designerOpts, { member: { view_all: true } }).catch(e => e)
    expect(escalate.statusCode).toBe(403)
    expect((await putGrants(designerOpts, { [viewer]: { read: true } })).grants).toEqual({ [viewer]: { read: true } })

    // A true row stored by an admin may be kept, but not copied to another role.
    await putGrants(withOrgHeader(auth, org.slug), { [viewer]: { view_all: true } })
    const kept = await putGrants(designerOpts, { [viewer]: { view_all: true }, member: { update: false } })
    expect(kept.grants).toEqual({ [viewer]: { view_all: true }, member: { update: false } })
    const copied = await putGrants(designerOpts, { [viewer]: { view_all: true }, [other]: { view_all: true } }).catch(e => e)
    expect(copied.statusCode).toBe(403)
  })

  it('PUT validates role names and rejects admin rows', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const unknown = await putGrants(opts, { ghosts: { read: true } }).catch(e => e)
    expect(unknown.statusCode).toBe(400)
    expect(String(unknown.data?.statusMessage ?? unknown.message)).toContain('Unknown role(s): ghosts')

    const admin = await putGrants(opts, { admin: { read: false } }).catch(e => e)
    expect(admin.statusCode).toBe(400)

    const badAction = await putGrants(opts, { member: { fly: true } }).catch(e => e)
    expect(badAction.statusCode).toBe(400)
  })

  it('404s on unknown record types', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const missing = await getView(opts, 'no_such_type').catch(e => e)
    expect(missing.statusCode).toBe(404)
  })
})
