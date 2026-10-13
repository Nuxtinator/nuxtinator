// MCP access for a user whose permissions come only from org memberships:
// no `users.roles`, no `is_admin`. Covers the OAuth consent gate (the
// scope filter must see membership-derived permissions) and the tools/call
// permission gate, which is evaluated for the org each call targets.
import { describe, it, expect, afterEach } from 'vitest'
import { url as nuxtUrl } from '@nuxt/test-utils/e2e'
import { createHash, randomBytes } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextUser,
  createContextOrg,
  addTestMembership,
  createTestPortfolio,
  getAuthHeaders,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()

// A plain org admin in org A. Everything the user can do comes from that
// membership row.
async function setupMember() {
  const user = await createContextUser(sql)
  const orgA = await createContextOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgA.id, roles: ['admin'] })
  return { user, orgA }
}

describe('MCP access for org members without host-level roles', () => {
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-context-%'`
  })

  it('/oauth/authorize reaches the consent step instead of invalid_scope', async () => {
    const { user, orgA } = await setupMember()
    const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
    const meta = await metaRes.json() as { resource: string }

    const clientId = `test-context-${randomBytes(8).toString('hex')}`
    const redirectUri = 'http://localhost:9999/callback'
    await sql`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris, scope)
      VALUES (${clientId}, 'test-context authorize client', ${[redirectUri]}, 'context.read offline_access')
    `
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'context.read offline_access',
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: meta.resource
    })

    // The browser carries the session cookie plus the active-org cookie the
    // app sets on every tenant request; the pending-request row is
    // tenant-scoped and needs that org.
    const res = await fetch(nuxtUrl(`/oauth/authorize?${params}`), {
      redirect: 'manual',
      headers: { cookie: `${getAuthHeaders(user).headers.cookie}; active-org-slug=${orgA.slug}` }
    })
    const location = res.headers.get('location') ?? ''
    expect(res.status, location).toBe(302)
    expect(location).not.toContain('error=invalid_scope')
    expect(location).toContain('/oauth/consent?request_id=')

    // The consent screen names each permission by its registered title.
    const consentPath = new URL(location, nuxtUrl('/'))
    const csrfCookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const consent = await fetch(nuxtUrl(`${consentPath.pathname}${consentPath.search}`), {
      headers: { cookie: `${getAuthHeaders(user).headers.cookie}; active-org-slug=${orgA.slug}; ${csrfCookie}` }
    })
    const html = await consent.text()
    expect(consent.status, html).toBe(200)
    expect(html).toContain('Read portfolios')
    expect(html).toContain('Stay connected')
  })

  it('tools/call passes the permission gate for the org the member belongs to', async () => {
    const { user, orgA } = await setupMember()
    await createTestPortfolio(sql, { org_id: orgA.id, name: 'Member Reads' })
    const token = await issueMcpBearer(sql, user.id, ['context.read'])

    const result = await callMcpTool(token, 'list_portfolios', { org: orgA.slug })
    expect(result.isError, result.content[0]?.text).toBeFalsy()
  })

  it('tools/call evaluates the permission gate per org', async () => {
    const { user, orgA } = await setupMember()
    // Member of org B under a role that grants nothing there.
    const orgB = await createContextOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: orgB.id, roles: ['test-context-no-grants'] })
    const token = await issueMcpBearer(sql, user.id, ['context.read'])

    const denied = await callMcpTool(token, 'list_portfolios', { org: orgB.slug })
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent?.error).toBe('insufficient_permission')

    const allowed = await callMcpTool(token, 'list_portfolios', { org: orgA.slug })
    expect(allowed.isError, allowed.content[0]?.text).toBeFalsy()
  })
})
