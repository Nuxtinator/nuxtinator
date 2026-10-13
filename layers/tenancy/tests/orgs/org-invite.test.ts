// POST /api/o/[orgSlug]/invite — per-org invite. Requires org.members.invite.
// Subset-delegation: cannot grant a permission you don't hold yourself.
import { describe, it, expect, afterEach, afterAll, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOrgWithAdmin,
  createTenancyUser,
  addTestMembership,
  withOrgHeader,
  getAuthHeaders,
  waitForMailTo,
  extractTokenFromBody,
  clearMailhog
} from '../helpers'

describe('POST /api/o/[orgSlug]/invite', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await clearMailhog()
  })

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('returns 403 when caller lacks org.members.invite (member role)', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: ['member'] })

    const err = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email: 'someone@example.com', display_name: 'X', roles: ['member'] },
      ...withOrgHeader(getAuthHeaders(member), org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })

  it('returns 400 for invalid email', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const err = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email: 'not-an-email', display_name: 'X', roles: ['member'] },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('admin invites a new email → an invite for this org + email sent; no user row', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const email = `test-tenancy-orginvite-${randomUUID().slice(0, 8)}@example.com`

    const res = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email, display_name: 'New Person', roles: ['member'] },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.status).toBe('pending')

    const users = await sql`SELECT 1 FROM users WHERE email = ${email}`
    expect(users.length).toBe(0)

    const orgs = await sql<{ roles: string[] }[]>`SELECT roles FROM invite_orgs WHERE invite_id = ${res.invite.id} AND org_id = ${org.id}`
    expect(orgs[0]!.roles).toEqual(['member'])

    const msg = await waitForMailTo(email)
    const token = extractTokenFromBody(msg.body, 'token')
    const info = await $fetch(`/api/auth/invite-info?token=${token}`)
    expect(info.orgs[0].slug).toBe(org.slug)
  })

  it('returns 409 when an invite is already pending for that email in this org', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const email = `test-tenancy-orginvite-${randomUUID().slice(0, 8)}@example.com`
    await $fetch(`/api/o/${org.slug}/invite`, { method: 'POST', body: { email, roles: ['member'] }, ...withOrgHeader(auth, org.slug) })
    const err = await $fetch(`/api/o/${org.slug}/invite`, { method: 'POST', body: { email, roles: ['member'] }, ...withOrgHeader(auth, org.slug) }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('creates a link invite, lists it, and revokes it', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const res = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { link: true, display_name: 'test-tenancy-link', roles: ['member'] },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.invite.kind).toBe('link')
    expect(res.invite.url).toMatch(/\/accept-invite\?token=/)

    const list = await $fetch<{ invites: Array<{ id: string, kind: string }> }>(`/api/o/${org.slug}/invites`, withOrgHeader(auth, org.slug))
    expect(list.invites.map(i => i.id)).toContain(res.invite.id)

    await $fetch(`/api/o/${org.slug}/invites/${res.invite.id}`, { method: 'DELETE', ...withOrgHeader(auth, org.slug) })
    const after = await sql`SELECT 1 FROM invites WHERE id = ${res.invite.id}`
    expect(after.length).toBe(0)
  })

  it('admin attaches an existing user → no email sent, membership created', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const existing = await createTenancyUser(sql)

    const res = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email: existing.email, roles: ['member'] },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.status).toBe('attached')

    const memberships = await sql<{ c: number }[]>`
      SELECT count(*)::int as c FROM memberships WHERE user_id = ${existing.id} AND org_id = ${org.id}
    `
    expect(memberships[0]!.c).toBe(1)

    let mailErr: unknown = null
    try { await waitForMailTo(existing.email, 800) } catch (e) { mailErr = e }
    expect(mailErr).not.toBeNull()
  })

  it('returns 409 when target is already a member', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const existing = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: existing.id, org_id: org.id, roles: ['member'] })

    const err = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email: existing.email, roles: ['member'] },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('returns 400 for an unknown role name', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const err = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email: `test-tenancy-${randomUUID().slice(0, 8)}@example.com`, display_name: 'X', roles: ['fake_role'] },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('admin can invite at the admin role (admin holds every permission)', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const email = `test-tenancy-${randomUUID().slice(0, 8)}@example.com`

    const res = await $fetch(`/api/o/${org.slug}/invite`, {
      method: 'POST',
      body: { email, display_name: 'New Admin', roles: ['admin'] },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.status).toBe('pending')
    const orgs = await sql<{ roles: string[] }[]>`SELECT roles FROM invite_orgs WHERE invite_id = ${res.invite.id}`
    expect(orgs[0]!.roles).toEqual(['admin'])
  })
})
