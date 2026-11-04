// Redirect URI scheme classes accepted by the OAuth layer, driven through
// dynamic client registration and the authorize endpoint on the booted host:
// a native app's private-use scheme (RFC 8252 §7.1, what Cursor registers),
// the authority-less reverse-domain form, https, and http on loopback only.
// Browser-executable schemes are refused.
import { describe, it, expect, afterEach } from 'vitest'
import { url as nuxtUrl } from '@nuxt/test-utils/e2e'
import { createHash, randomBytes } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextUser,
  createContextOrg,
  addTestMembership,
  getAuthHeaders
} from '../helpers'

const sql = getHostAdminDb()

interface RegisterResponse {
  status: number
  body: { client_id?: string, redirect_uris?: string[], error?: string, error_description?: string }
}

async function register(redirectUris: string[]): Promise<RegisterResponse> {
  const res = await fetch(nuxtUrl('/oauth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `test-context scheme ${randomBytes(4).toString('hex')}`,
      redirect_uris: redirectUris,
      scope: 'context.read offline_access'
    })
  })
  return { status: res.status, body: await res.json() as RegisterResponse['body'] }
}

describe('OAuth redirect URI schemes', () => {
  // Orgs go first: their cascade removes the pending requests that
  // reference the registered clients.
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_name LIKE 'test-context scheme %'`
  })

  it('registers a private-use scheme callback verbatim', async () => {
    const uri = 'cursor://anysphere.cursor-mcp/oauth/callback'
    const { status, body } = await register([uri])
    expect(status, JSON.stringify(body)).toBeLessThan(300)
    expect(body.redirect_uris).toEqual([uri])
  })

  it('registers the authority-less reverse-domain form', async () => {
    const uri = 'com.example.app:/oauth2redirect'
    const { status, body } = await register([uri])
    expect(status, JSON.stringify(body)).toBeLessThan(300)
    expect(body.redirect_uris).toEqual([uri])
  })

  it('still refuses http to a non-loopback host', async () => {
    const { status, body } = await register(['http://example.com/callback'])
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_redirect_uri')
    expect(body.error_description).toContain('loopback')
  })

  it('refuses browser-executable schemes', async () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd']) {
      const { status, body } = await register([uri])
      expect(status, uri).toBe(400)
      expect(body.error, uri).toBe('invalid_redirect_uri')
    }
  })

  it('authorize accepts the registered private-use callback and reaches consent', async () => {
    const uri = 'cursor://anysphere.cursor-mcp/oauth/callback'
    const { body } = await register([uri])
    const clientId = body.client_id!

    const user = await createContextUser(sql)
    const org = await createContextOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })

    const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
    const meta = await metaRes.json() as { resource: string }
    const verifier = randomBytes(32).toString('base64url')
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: uri,
      scope: 'context.read offline_access',
      state: 'cursor-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: meta.resource
    })
    const res = await fetch(nuxtUrl(`/oauth/authorize?${params}`), {
      redirect: 'manual',
      headers: { cookie: `${getAuthHeaders(user).headers.cookie}; active-org-slug=${org.slug}` }
    })
    const location = res.headers.get('location') ?? ''
    expect(res.status, location).toBe(302)
    expect(location).toContain('/oauth/consent?request_id=')
  })
})
