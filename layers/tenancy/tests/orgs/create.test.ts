import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin,
  createTenancyUser,
  getAuthHeaders
} from '../helpers'

describe('POST /api/admin/orgs', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })
  it('returns 403 when caller is not an operator admin', async () => {
    const user = await createTenancyUser(sql)
    const err = await $fetch('/api/admin/orgs', {
      method: 'POST',
      body: { name: 'Acme Inc.', slug: `test-tenancy-${randomUUID().slice(0, 8)}` },
      ...getAuthHeaders(user)
    }).catch(e => e)

    expect(err.statusCode).toBe(403)
  })

  it('returns 401 when no auth cookie is present', async () => {
    const err = await $fetch('/api/admin/orgs', {
      method: 'POST',
      body: { name: 'Acme', slug: `test-tenancy-${randomUUID().slice(0, 8)}` }
    }).catch(e => e)

    expect(err.statusCode).toBe(401)
  })

  it('operator admin creates an org; orgs row + initial admin membership exist', async () => {
    const { user, auth } = await createOperatorAdmin(sql)
    const slug = `test-tenancy-${randomUUID().slice(0, 8)}`

    await $fetch('/api/admin/orgs', {
      method: 'POST',
      body: { name: 'Acme Inc.', slug, initialAdminUserId: user.id },
      ...auth
    })

    const orgs = await sql<{ id: string, slug: string, name: string }[]>`
      SELECT id, slug, name FROM orgs WHERE slug = ${slug}
    `
    expect(orgs.length).toBe(1)
    expect(orgs[0]!.name).toBe('Acme Inc.')

    const memberships = await sql<{ user_id: string, roles: string[] }[]>`
      SELECT user_id, roles FROM memberships WHERE org_id = ${orgs[0]!.id}
    `
    expect(memberships.length).toBe(1)
    expect(memberships[0]!.user_id).toBe(user.id)
    expect(memberships[0]!.roles).toEqual(['admin'])
  })

  it('rejects an invalid slug with 400', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const err = await $fetch('/api/admin/orgs', {
      method: 'POST',
      body: { name: 'Acme', slug: 'INVALID SLUG!' },
      ...auth
    }).catch(e => e)

    expect(err.statusCode).toBe(400)
  })

  it('rejects a slug starting nx-, which the mail kernel reserves', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const slug = `nx-${randomUUID().slice(0, 8)}`
    const err = await $fetch('/api/admin/orgs', {
      method: 'POST',
      body: { name: 'Acme', slug },
      ...auth
    }).catch(e => e)

    expect(err.statusCode).toBe(400)
    expect(await sql`SELECT 1 FROM orgs WHERE slug = ${slug}`).toHaveLength(0)
  })
})
