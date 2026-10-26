// Revoking a connected app from the user's account clears its consent in
// every org, so the next authorize request asks for consent again instead
// of issuing a code silently.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, url as nuxtUrl } from '@nuxt/test-utils/e2e'
import { createHash, randomBytes } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextUser,
  createContextOrg,
  addTestMembership,
  getAuthHeaders,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
const REDIRECT_URI = 'http://127.0.0.1:8976/callback'
const SCOPE = 'context.read'

describe('OAuth connected-app revoke', () => {
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_name LIKE 'test-context revoke %'`
  })

  it('revokes the consent in its org, so authorize shows consent again', async () => {
    const reg = await fetch(nuxtUrl('/oauth/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: `test-context revoke ${randomBytes(4).toString('hex')}`,
        redirect_uris: [REDIRECT_URI],
        scope: SCOPE
      })
    })
    const clientId = (await reg.json() as { client_id: string }).client_id

    const user = await createContextUser(sql)
    const orgA = await createContextOrg(sql)
    const orgB = await createContextOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: orgA.id, roles: ['admin'] })
    await addTestMembership(sql, { user_id: user.id, org_id: orgB.id, roles: ['admin'] })

    const meta = await (await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))).json() as { resource: string }
    await sql`
      INSERT INTO oauth_consents (client_id, user_id, resource, scope, org_id)
      VALUES (${clientId}, ${user.id}, ${meta.resource}, ${SCOPE}, ${orgB.id})
    `

    const authorize = async (): Promise<string> => {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: 'revoke-state',
        code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
        code_challenge_method: 'S256',
        resource: meta.resource
      })
      const res = await fetch(nuxtUrl(`/oauth/authorize?${params}`), {
        redirect: 'manual',
        headers: { cookie: `${getAuthHeaders(user).headers.cookie}; active-org-slug=${orgB.slug}` }
      })
      const location = res.headers.get('location') ?? ''
      expect(res.status, location).toBe(302)
      return location
    }

    const first = await authorize()
    expect(first.startsWith(`${REDIRECT_URI}?`), first).toBe(true)
    expect(new URL(first).searchParams.get('code')).toBeTruthy()

    // Active org A; the consent sits in org B.
    const res = await $fetch<{ consents_revoked: number }>(
      `/api/oauth/connected-apps/${clientId}`,
      { method: 'DELETE', ...withOrgHeader(getAuthHeaders(user), orgA.slug) }
    )
    expect(res.consents_revoked).toBe(1)

    const [row] = await sql<{ revoked: boolean }[]>`
      SELECT revoked FROM oauth_consents WHERE client_id = ${clientId} AND user_id = ${user.id}
    `
    expect(row!.revoked).toBe(true)

    expect(await authorize()).toContain('/oauth/consent?request_id=')
  })
})
