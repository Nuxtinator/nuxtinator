// OAuth access tokens on the multi-mode `#tenant/server` handlers, and the
// consent choices that decide what a token carries.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  cleanupTestOauthClients,
  createOrgWithAdmin,
  createTestOrg,
  addTestMembership,
  createTestOauthClient,
  createTestOauthToken,
  getOauthResource,
  bearer
} from '../helpers'

describe('OAuth bearer tokens on tenant routes', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTestOauthClients(sql)
    await cleanupTenancyTestData(sql)
  })

  it('accepts a token carrying the route permission, with the org from the path', async () => {
    const { org, user } = await createOrgWithAdmin(sql)
    const { token } = await createTestOauthToken(sql, user, ['org.roles.read'])

    const res = await fetch(`/api/o/${org.slug}/permissions`, bearer(token))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('active-org-slug')
  })

  it('refuses a token without the route permission as a scope', async () => {
    const { org, user } = await createOrgWithAdmin(sql)
    const { token } = await createTestOauthToken(sql, user, ['context.read'])

    const res = await fetch(`/api/o/${org.slug}/permissions`, bearer(token))
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  it('refuses tokens on a route that names no permission', async () => {
    const { org, user } = await createOrgWithAdmin(sql)
    const { token } = await createTestOauthToken(sql, user, ['org.roles.read'])

    const res = await fetch(`/api/o/${org.slug}/`, bearer(token))
    expect(res.status).toBe(403)
  })

  it('404s an org the token user does not belong to', async () => {
    const { user } = await createOrgWithAdmin(sql)
    const other = await createTestOrg(sql)
    const { token } = await createTestOauthToken(sql, user, ['context.read'])

    const res = await fetch('/api/context/templates', bearer(token, { 'x-active-org': other.slug }))
    expect(res.status).toBe(404)
  })

  it('takes the org from X-Active-Org, else the only membership', async () => {
    const { org, user } = await createOrgWithAdmin(sql)
    const { token } = await createTestOauthToken(sql, user, ['context.read'])

    expect((await fetch('/api/context/templates', bearer(token, { 'x-active-org': org.slug }))).status).toBe(200)
    expect((await fetch('/api/context/templates', bearer(token))).status).toBe(200)
  })

  it('400s with several memberships and no org selected', async () => {
    const { user } = await createOrgWithAdmin(sql)
    const second = await createTestOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: second.id, roles: ['admin'] })
    const { token } = await createTestOauthToken(sql, user, ['context.read'])

    const res = await fetch('/api/context/templates', bearer(token))
    expect(res.status).toBe(400)
  })

  it('423s a suspended org and 410s an app that is off', async () => {
    const { org, user } = await createOrgWithAdmin(sql)
    const { token } = await createTestOauthToken(sql, user, ['context.read'])
    const headers = bearer(token, { 'x-active-org': org.slug })

    await sql`UPDATE org_apps SET enabled = false WHERE org_id = ${org.id} AND app_id = 'context'`
    expect((await fetch('/api/context/templates', headers)).status).toBe(410)

    await sql`UPDATE orgs SET suspended_at = now() WHERE id = ${org.id}`
    expect((await fetch('/api/context/templates', headers)).status).toBe(423)
  })

  it('records the client on the activity log', async () => {
    const { org, user } = await createOrgWithAdmin(sql)
    const { token, clientId } = await createTestOauthToken(sql, user, ['context.portfolio.create'])

    const created = await $fetch<{ id: string }>('/api/context/portfolios', {
      method: 'POST',
      body: { name: 'test-tenancy portfolio', builtin_sections: [] },
      ...bearer(token, { 'x-active-org': org.slug })
    })

    // The log write is fire-and-forget.
    let row: { client_id: string | null, user_id: string | null } | undefined
    for (let i = 0; i < 20 && !row; i++) {
      [row] = await sql<{ client_id: string | null, user_id: string | null }[]>`
        SELECT client_id, user_id FROM activity_logs WHERE record_id = ${created.id} AND event_type = 'CREATE'
      `
      if (!row) await new Promise(r => setTimeout(r, 100))
    }
    expect(row).toEqual({ client_id: clientId, user_id: user.id })
  })
})

describe('connected-app permission edits', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTestOauthClients(sql)
    await cleanupTenancyTestData(sql)
  })

  async function connect(scopes: string[]) {
    const { org, user, auth } = await createOrgWithAdmin(sql)
    const issued = await createTestOauthToken(sql, user, scopes, { refresh: true })
    await sql`
      INSERT INTO oauth_consents (client_id, user_id, resource, scope, org_id)
      VALUES (${issued.clientId}, ${user.id}, ${await getOauthResource()}, ${scopes.join(' ')}, ${org.id})
    `
    return { org, user, auth, ...issued }
  }

  const tokenScopes = async (table: 'oauth_access_tokens' | 'oauth_refresh_tokens', familyId: string) => {
    const [row] = await sql<{ scope: string }[]>`SELECT scope FROM ${sql(table)} WHERE family_id = ${familyId}`
    return row!.scope.split(' ').filter(Boolean).sort()
  }

  it('cuts a removed permission from live tokens at once and adds one back at the next refresh', async () => {
    const c = await connect(['context.read', 'org.roles.read', 'offline_access'])

    await $fetch(`/api/oauth/connected-apps/${c.clientId}`, {
      method: 'PATCH',
      body: { scopes: ['context.read', 'offline_access'] },
      ...c.auth
    })
    expect(await tokenScopes('oauth_access_tokens', c.familyId)).toEqual(['context.read', 'offline_access'])
    expect((await fetch(`/api/o/${c.org.slug}/permissions`, bearer(c.token))).status).toBe(403)

    const [consent] = await sql<{ scope: string, declined_scope: string }[]>`
      SELECT scope, declined_scope FROM oauth_consents WHERE client_id = ${c.clientId}
    `
    expect(consent).toEqual({ scope: 'context.read offline_access', declined_scope: 'org.roles.read' })

    await $fetch(`/api/oauth/connected-apps/${c.clientId}`, {
      method: 'PATCH',
      body: { scopes: ['context.read', 'org.roles.read', 'offline_access'] },
      ...c.auth
    })
    expect(await tokenScopes('oauth_access_tokens', c.familyId)).toEqual(['context.read', 'offline_access'])
    expect(await tokenScopes('oauth_refresh_tokens', c.familyId)).toEqual(['context.read', 'offline_access', 'org.roles.read'])
  })

  it('refuses an edit that leaves no permission', async () => {
    const c = await connect(['context.read', 'offline_access'])

    const err = await $fetch(`/api/oauth/connected-apps/${c.clientId}`, {
      method: 'PATCH',
      body: { scopes: ['offline_access'] },
      ...c.auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('lists asked-for permissions grouped by app with what is granted', async () => {
    const c = await connect(['context.read', 'org.roles.read'])
    await sql`UPDATE oauth_consents SET scope = 'context.read', declined_scope = 'org.roles.read' WHERE client_id = ${c.clientId}`

    const res = await $fetch<{ apps: { client_id: string, groups: { key: string, scopes: { scope: string, granted: boolean }[] }[] }[] }>(
      '/api/oauth/connected-apps',
      { headers: { ...c.auth.headers, 'x-active-org': c.org.slug } }
    )
    const app = res.apps.find(a => a.client_id === c.clientId)!
    const flat = app.groups.flatMap(g => g.scopes.map(s => [g.key, s.scope, s.granted]))
    expect(flat).toEqual(expect.arrayContaining([['context', 'context.read', true], ['org', 'org.roles.read', false]]))
  })
})

describe('consent screen choices', () => {
  const sql = getHostAdminDb()
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

  afterEach(async () => {
    await cleanupTestOauthClients(sql)
    await cleanupTenancyTestData(sql)
  })

  async function authorize(clientId: string, scopes: string[], cookie: string) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9/callback',
      scope: scopes.join(' '),
      state: 'st',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: await getOauthResource()
    })
    return await fetch(`/oauth/authorize?${params}`, {
      redirect: 'manual',
      headers: { cookie, 'x-forwarded-for': `test-${randomUUID()}` }
    })
  }

  it('saves unticked permissions as declined and skips the screen when asked again', async () => {
    const { user, auth } = await createOrgWithAdmin(sql)
    const scopes = ['context.read', 'org.roles.read', 'offline_access']
    const clientId = await createTestOauthClient(sql, { scopes })
    const session = auth.headers.cookie

    const start = await authorize(clientId, scopes, session)
    expect(start.status).toBe(302)
    const consentUrl = start.headers.get('location')!
    expect(consentUrl).toContain('/oauth/consent')
    const consentCookie = start.headers.getSetCookie().find(c => c.startsWith('oauth_consent_token_'))!.split(';')[0]!
    const cookie = `${session}; ${consentCookie}`

    const page = await (await fetch(consentUrl, { headers: { cookie } })).text()
    expect(page).toContain('value="org.roles.read"')
    const csrf = page.match(/name="csrf_token" value="([^"]+)"/)![1]!
    const requestId = new URL(consentUrl, 'http://x').searchParams.get('request_id')!

    const form = new URLSearchParams({ request_id: requestId, csrf_token: csrf, action: 'approve' })
    form.append('scope', 'context.read')
    form.append('scope', 'offline_access')
    const approved = await fetch('/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    })
    expect(approved.status).toBe(302)
    expect(approved.headers.get('location')).toContain('code=')

    const [consent] = await sql<{ scope: string, declined_scope: string }[]>`
      SELECT scope, declined_scope FROM oauth_consents WHERE client_id = ${clientId} AND user_id = ${user.id}
    `
    expect(consent).toEqual({ scope: 'context.read offline_access', declined_scope: 'org.roles.read' })
    const [code] = await sql<{ scope: string }[]>`SELECT scope FROM oauth_authorization_codes WHERE client_id = ${clientId}`
    expect(code!.scope).toBe('context.read offline_access')

    const again = await authorize(clientId, scopes, session)
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toMatch(/^http:\/\/127\.0\.0\.1:9\/callback\?code=/)
  })

  it('shows the screen again for a permission the user has not answered', async () => {
    const { org, user, auth } = await createOrgWithAdmin(sql)
    const clientId = await createTestOauthClient(sql, { scopes: ['context.read', 'org.roles.read'] })
    await sql`
      INSERT INTO oauth_consents (client_id, user_id, resource, scope, org_id)
      VALUES (${clientId}, ${user.id}, ${await getOauthResource()}, 'context.read', ${org.id})
    `

    const res = await authorize(clientId, ['context.read', 'org.roles.read'], auth.headers.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/oauth/consent')
  })
})
