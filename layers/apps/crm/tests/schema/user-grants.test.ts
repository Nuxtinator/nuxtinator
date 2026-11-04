// The per-user grants routes and the crm.* permission catalog: grants are
// restricted to crm.*-prefixed registered slugs, additive on top of roles,
// scoped to org members, and orphan slugs stay listed and revocable.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  createCrmUser,
  addCrmMember,
  withOrgHeader
} from '../helpers'

type Opts = ReturnType<typeof withOrgHeader>

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

interface GrantItem {
  permission: string
  title: string
  orphan: boolean
}

function getGrants(opts: Opts, userId: string): Promise<{ items: GrantItem[] }> {
  return $fetch<{ items: GrantItem[] }>('/api/crm/schema/user-grants', { query: { userId }, ...opts })
}

function postGrant(opts: Opts, userId: string, permission: string): Promise<{ items: GrantItem[] }> {
  return $fetch<{ items: GrantItem[] }>('/api/crm/schema/user-grants', {
    method: 'POST',
    body: { userId, permission },
    ...opts
  })
}

function deleteGrant(opts: Opts, userId: string, permission: string): Promise<{ items: GrantItem[] }> {
  return $fetch<{ items: GrantItem[] }>(`/api/crm/schema/user-grants/${userId}/${permission}`, {
    method: 'DELETE',
    ...opts
  })
}

describe('permission catalog', () => {
  it('lists registered crm.* slugs with meta, gated on crm.schema.manage', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const member = await addCrmMember(sql, org.id, ['member'])

    const res = await $fetch<{ permissions: Array<{ key: string, title: string, description: string }> }>(
      '/api/crm/schema/permissions', withOrgHeader(auth, org.slug)
    )
    expect(res.permissions.every(p => p.key.startsWith('crm.'))).toBe(true)
    expect(res.permissions.find(p => p.key === 'crm.contacts.view_all')).toMatchObject({
      title: 'View all contacts'
    })

    const denied = await $fetch('/api/crm/schema/permissions', withOrgHeader(member.auth, org.slug)).catch(e => e)
    expect(denied.statusCode).toBe(403)
  })
})

describe('user-grants routes', () => {
  it('grants round-trip and are additive — the granted slug takes effect', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const member = await addCrmMember(sql, org.id, ['member'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const memberOpts = withOrgHeader(member.auth, org.slug)

    const before = await getGrants(adminOpts, member.user.id)
    expect(before.items).toEqual([])

    // member's roles don't carry crm.schema.manage; the direct grant adds it.
    const denied = await $fetch('/api/crm/schema/permissions', memberOpts).catch(e => e)
    expect(denied.statusCode).toBe(403)

    const granted = await postGrant(adminOpts, member.user.id, 'crm.schema.manage')
    expect(granted.items).toMatchObject([{ permission: 'crm.schema.manage', orphan: false }])

    const allowed = await $fetch<{ permissions: unknown[] }>('/api/crm/schema/permissions', memberOpts)
    expect(allowed.permissions.length).toBeGreaterThan(0)

    const revoked = await deleteGrant(adminOpts, member.user.id, 'crm.schema.manage')
    expect(revoked.items).toEqual([])
    const deniedAgain = await $fetch('/api/crm/schema/permissions', memberOpts).catch(e => e)
    expect(deniedAgain.statusCode).toBe(403)
  })

  it('a non-admin grantor can only grant permissions they hold', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const designer = await addCrmMember(sql, org.id, ['member'])
    const other = await addCrmMember(sql, org.id, ['member'])
    await postGrant(withOrgHeader(auth, org.slug), designer.user.id, 'crm.schema.manage')
    const designerOpts = withOrgHeader(designer.auth, org.slug)

    const escalate = await postGrant(designerOpts, designer.user.id, 'crm.contacts.view_all').catch(e => e)
    expect(escalate.statusCode).toBe(403)
    const forOther = await postGrant(designerOpts, other.user.id, 'crm.contacts.view_all').catch(e => e)
    expect(forOther.statusCode).toBe(403)

    const held = await postGrant(designerOpts, other.user.id, 'crm.schema.manage')
    expect(held.items).toMatchObject([{ permission: 'crm.schema.manage' }])
  })

  it('rejects non-crm slugs, unregistered crm slugs, and non-member targets', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const member = await addCrmMember(sql, org.id, ['member'])
    const opts = withOrgHeader(auth, org.slug)

    const foreign = await postGrant(opts, member.user.id, 'org.roles.read').catch(e => e)
    expect(foreign.statusCode).toBe(400)
    expect(String(foreign.data?.statusMessage ?? foreign.message)).toContain('crm.*')

    const bogus = await postGrant(opts, member.user.id, 'crm.bogus.slug').catch(e => e)
    expect(bogus.statusCode).toBe(400)

    // A real user outside the org is not a valid target in multi mode.
    const outsider = await createCrmUser(sql)
    const nonMember = await postGrant(opts, outsider.id, 'crm.contacts.read').catch(e => e)
    expect(nonMember.statusCode).toBe(400)
  })

  it('lists orphan crm.* grants flagged and lets them be revoked', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const member = await addCrmMember(sql, org.id, ['member'])
    const opts = withOrgHeader(auth, org.slug)

    // A leftover grant whose slug no longer exists in any registry.
    await sql`
      INSERT INTO user_permission_grants (id, user_id, permission, org_id)
      VALUES (${randomUUID()}, ${member.user.id}, ${'crm.zombie.slug'}, ${org.id})
    `

    const listed = await getGrants(opts, member.user.id)
    expect(listed.items).toMatchObject([{ permission: 'crm.zombie.slug', orphan: true }])

    const revoked = await deleteGrant(opts, member.user.id, 'crm.zombie.slug')
    expect(revoked.items).toEqual([])
  })
})
