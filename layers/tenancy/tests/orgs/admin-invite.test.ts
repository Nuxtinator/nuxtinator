// Host-admin multi-org invite. Lives in core but requires tenancy (orgs +
// memberships tables, requireOperatorAdmin from #tenant/server).
//
// Paths:
//   - new email   → an invite row carrying the orgs + an invite email; no user
//   - link        → an invite row with no email; the URL comes back to share
//   - existing email → silent attach: only memberships, no email
import { describe, it, expect, afterEach, afterAll, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin,
  createTenancyUser,
  createTestOrg,
  waitForMailTo,
  extractTokenFromBody,
  clearMailhog
} from '../helpers'

describe('POST /api/admin/users/invite (host-admin multi-org)', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await clearMailhog()
  })

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('returns 400 with invalid email', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)
    const err = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: { email: 'not-an-email', display_name: 'X', attachments: [{ orgId: org.id, roles: ['member'] }] },
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 400 when attachments is empty', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const err = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: { email: `test-tenancy-${randomUUID().slice(0, 8)}@example.com`, display_name: 'Bob', attachments: [] },
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 400 when an attachment org does not exist', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const err = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: {
        email: `test-tenancy-${randomUUID().slice(0, 8)}@example.com`,
        display_name: 'Ghost',
        attachments: [{ orgId: randomUUID(), roles: ['member'] }]
      },
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('new email → creates an invite carrying the orgs and sends one email; no user row', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const orgA = await createTestOrg(sql)
    const orgB = await createTestOrg(sql)
    const email = `test-tenancy-invite-${randomUUID().slice(0, 8)}@example.com`

    const res = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: {
        email,
        display_name: 'Multi Org User',
        attachments: [
          { orgId: orgA.id, roles: ['admin'] },
          { orgId: orgB.id, roles: ['member'] }
        ]
      },
      ...auth
    })

    expect(res.invite.kind).toBe('email')
    expect(res.attachments.every((a: { status: string }) => a.status === 'pending')).toBe(true)

    const users = await sql`SELECT 1 FROM users WHERE email = ${email}`
    expect(users.length).toBe(0)

    const orgs = await sql<{ org_id: string, roles: string[] }[]>`
      SELECT org_id, roles FROM invite_orgs WHERE invite_id = ${res.invite.id}
    `
    expect(orgs.find(o => o.org_id === orgA.id)!.roles).toEqual(['admin'])
    expect(orgs.find(o => o.org_id === orgB.id)!.roles).toEqual(['member'])

    // The emailed token opens this invite.
    const msg = await waitForMailTo(email)
    const token = extractTokenFromBody(msg.body, 'token')
    const info = await $fetch(`/api/auth/invite-info?token=${token}`)
    expect(info.email).toBe(email)
    expect(info.orgs.map((o: { slug: string }) => o.slug).sort()).toEqual([orgA.slug, orgB.slug].sort())
  })

  it('link → returns a shareable URL, and accepting it grants the orgs', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)

    const res = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: { link: true, display_name: 'test-tenancy-link', attachments: [{ orgId: org.id, roles: ['member'] }] },
      ...auth
    })
    expect(res.invite.kind).toBe('link')
    const token = new URL(res.invite.url).searchParams.get('token')!

    const joiner = await createTenancyUser(sql)
    await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token },
      ...(await import('../helpers')).getAuthHeaders(joiner)
    })

    const memberships = await sql<{ roles: string[] }[]>`
      SELECT roles FROM memberships WHERE user_id = ${joiner.id} AND org_id = ${org.id}
    `
    expect(memberships[0]!.roles).toEqual(['member'])
  })

  it('accepting into an account already in the org adds the invite\'s roles to the existing ones', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)
    const existing = await createTenancyUser(sql)
    await sql`INSERT INTO memberships (id, user_id, org_id, roles) VALUES (${randomUUID()}, ${existing.id}, ${org.id}, ${'{member}'})`

    const res = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: { link: true, display_name: 'test-tenancy-link', attachments: [{ orgId: org.id, roles: ['admin'] }] },
      ...auth
    })
    const token = new URL(res.invite.url).searchParams.get('token')!
    await $fetch('/api/auth/accept-invite', {
      method: 'POST',
      body: { token },
      ...(await import('../helpers')).getAuthHeaders(existing)
    })

    const rows = await sql<{ roles: string[] }[]>`SELECT roles FROM memberships WHERE user_id = ${existing.id} AND org_id = ${org.id}`
    expect(rows[0]!.roles.sort()).toEqual(['admin', 'member'])
  })

  it('lists, resends and revokes pending invites', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql)
    const email = `test-tenancy-invite-${randomUUID().slice(0, 8)}@example.com`
    const created = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: { email, attachments: [{ orgId: org.id, roles: ['member'] }] },
      ...auth
    })

    const list = await $fetch<{ invites: Array<{ id: string, status: string, orgs: Array<{ id: string }> }> }>('/api/admin/invites', auth)
    const row = list.invites.find(i => i.id === created.invite.id)!
    expect(row.status).toBe('valid')
    expect(row.orgs[0]!.id).toBe(org.id)

    await clearMailhog()
    await $fetch(`/api/admin/invites/${created.invite.id}/resend`, { method: 'POST', ...auth })
    await waitForMailTo(email)

    await $fetch(`/api/admin/invites/${created.invite.id}`, { method: 'DELETE', ...auth })
    const after = await sql`SELECT 1 FROM invites WHERE id = ${created.invite.id}`
    expect(after.length).toBe(0)
  })

  it('existing email → silent attach (memberships added, no email sent)', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const orgA = await createTestOrg(sql)
    const existing = await createTenancyUser(sql)

    const res = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: {
        email: existing.email,
        attachments: [{ orgId: orgA.id, roles: ['member'] }]
      },
      ...auth
    })
    expect(res.attachments[0].status).toBe('attached')

    const memberships = await sql<{ c: number }[]>`SELECT count(*)::int as c FROM memberships WHERE user_id = ${existing.id} AND org_id = ${orgA.id}`
    expect(memberships[0]!.c).toBe(1)

    // No email captured for an attach
    let mailErr: unknown = null
    try { await waitForMailTo(existing.email, 1000) } catch (e) { mailErr = e }
    expect(mailErr).not.toBeNull()
  })

  it('returns 409 when existing user is already a member of one of the requested orgs', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const orgA = await createTestOrg(sql)
    const existing = await createTenancyUser(sql)
    await sql`
      INSERT INTO memberships (id, user_id, org_id, roles)
      VALUES (${randomUUID()}, ${existing.id}, ${orgA.id}, ${'{member}'})
    `

    const err = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: {
        email: existing.email,
        attachments: [{ orgId: orgA.id, roles: ['admin'] }]
      },
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('non-operator-admin gets 403', async () => {
    const user = await createTenancyUser(sql)
    const org = await createTestOrg(sql)
    const { getAuthHeaders } = await import('../helpers')

    const err = await $fetch('/api/admin/users/invite', {
      method: 'POST',
      body: {
        email: `test-tenancy-${randomUUID().slice(0, 8)}@example.com`,
        display_name: 'X',
        attachments: [{ orgId: org.id, roles: ['member'] }]
      },
      ...getAuthHeaders(user)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})
