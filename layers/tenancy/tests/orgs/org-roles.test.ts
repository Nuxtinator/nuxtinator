// Custom roles + role overrides per-org. RLS scopes both tables to the
// active org; the cleanup CASCADE on orgs wipes them automatically.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOrgWithAdmin,
  createTenancyUser,
  addTestMembership,
  withOrgHeader,
  getAuthHeaders
} from '../helpers'

describe('Custom roles: GET/POST /api/o/[orgSlug]/roles', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('admin can list roles (empty when none defined)', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const res = await $fetch(`/api/o/${org.slug}/roles`, withOrgHeader(auth, org.slug))
    expect(Array.isArray(res.roles)).toBe(true)
    expect(res.roles.length).toBe(0)
  })

  it('admin can create a custom role with a permission they hold', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const res = await $fetch(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name: 'Inviter', description: 'Just the invite perm', permissions: ['org.members.invite'] },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.name).toBe('Inviter')
    expect(res.permissions).toEqual(['org.members.invite'])
    expect(res.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns 400 when name is too short', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const err = await $fetch(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name: 'X', permissions: [] },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 409 on duplicate role name in the same org', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const name = `Role-${randomUUID().slice(0, 6)}`
    await $fetch(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name, permissions: [] },
      ...withOrgHeader(auth, org.slug)
    })
    const err = await $fetch(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name, permissions: [] },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('subset-delegation: non-admin with limited perms cannot grant perms they lack', async () => {
    // Setup: org admin creates a custom role that grants only org.roles.write,
    // assigns it to a 2nd user, then that user tries to create another role
    // that grants org.members.invite (which they don't hold) → 403.
    const { org, auth } = await createOrgWithAdmin(sql)

    // Create the role and assign to a member
    const limitedRole = await $fetch(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name: 'OnlyRoleWrite', permissions: ['org.roles.write', 'org.roles.read'] },
      ...withOrgHeader(auth, org.slug)
    })

    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: [limitedRole.name] })

    const err = await $fetch(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name: 'WantsToInvite', permissions: ['org.members.invite'] },
      ...withOrgHeader(getAuthHeaders(member), org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(String(err.statusMessage)).toMatch(/org\.members\.invite/)
  })

  it('non-admin with no role-related perms gets 403 on list', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: ['member'] })

    const err = await $fetch(`/api/o/${org.slug}/roles`, withOrgHeader(getAuthHeaders(member), org.slug)).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})

describe('Role overrides: PUT/GET /api/o/[orgSlug]/role-overrides', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('PUT writes grant + revoke rows; GET returns them', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)

    await $fetch(`/api/o/${org.slug}/role-overrides`, {
      method: 'PUT',
      body: {
        role: 'member',
        grants: ['org.members.invite'],
        revokes: ['org.roles.read']
      },
      ...withOrgHeader(auth, org.slug)
    })

    const res = await $fetch(`/api/o/${org.slug}/role-overrides?role=member`, withOrgHeader(auth, org.slug))
    expect(res.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: 'org.members.invite', effect: 'grant' }),
      expect.objectContaining({ permission: 'org.roles.read', effect: 'revoke' })
    ]))
  })

  it('overrides change what the role grants in that org only', async () => {
    const a = await createOrgWithAdmin(sql)
    const b = await createOrgWithAdmin(sql)
    const user = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: a.org.id, roles: ['member'] })
    await addTestMembership(sql, { user_id: user.id, org_id: b.org.id, roles: ['member'] })
    const inA = withOrgHeader(getAuthHeaders(user), a.org.slug)
    const inB = withOrgHeader(getAuthHeaders(user), b.org.slug)

    // Members read the member list by default, but not roles.
    await $fetch(`/api/o/${a.org.slug}/members`, inA)
    expect((await $fetch(`/api/o/${a.org.slug}/roles`, inA).catch(e => e)).statusCode).toBe(403)

    await $fetch(`/api/o/${a.org.slug}/role-overrides`, {
      method: 'PUT',
      body: { role: 'member', grants: ['org.roles.read'], revokes: ['org.members.read'] },
      ...withOrgHeader(a.auth, a.org.slug)
    })

    expect((await $fetch(`/api/o/${a.org.slug}/members`, inA).catch(e => e)).statusCode).toBe(403)
    await $fetch(`/api/o/${a.org.slug}/roles`, inA)

    // Org B's member role is untouched.
    await $fetch(`/api/o/${b.org.slug}/members`, inB)
    expect((await $fetch(`/api/o/${b.org.slug}/roles`, inB).catch(e => e)).statusCode).toBe(403)
  })

  it('PUT replaces previous overrides for the same role (bulk-replace semantics)', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)

    await $fetch(`/api/o/${org.slug}/role-overrides`, {
      method: 'PUT',
      body: { role: 'member', grants: ['org.members.invite'], revokes: [] },
      ...withOrgHeader(auth, org.slug)
    })
    await $fetch(`/api/o/${org.slug}/role-overrides`, {
      method: 'PUT',
      body: { role: 'member', grants: [], revokes: [] }, // wipe
      ...withOrgHeader(auth, org.slug)
    })

    const res = await $fetch(`/api/o/${org.slug}/role-overrides?role=member`, withOrgHeader(auth, org.slug))
    expect(res.overrides).toEqual([])
  })

  it('returns 400 when grants and revokes overlap', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const err = await $fetch(`/api/o/${org.slug}/role-overrides`, {
      method: 'PUT',
      body: { role: 'member', grants: ['org.roles.read'], revokes: ['org.roles.read'] },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('GET returns 400 when role query param is missing', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const err = await $fetch(`/api/o/${org.slug}/role-overrides`, withOrgHeader(auth, org.slug)).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('subset-delegation: cannot grant a permission the editor does not hold', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)

    // Make a limited member with org.roles.write but not org.members.invite
    const role = await $fetch(`/api/o/${org.slug}/roles`, {
      method: 'POST',
      body: { name: 'OverrideEditor', permissions: ['org.roles.write', 'org.roles.read'] },
      ...withOrgHeader(auth, org.slug)
    })
    const limited = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: limited.id, org_id: org.id, roles: [role.name] })

    const err = await $fetch(`/api/o/${org.slug}/role-overrides`, {
      method: 'PUT',
      body: { role: 'member', grants: ['org.members.invite'], revokes: [] },
      ...withOrgHeader(getAuthHeaders(limited), org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})
