// The MCP dispatcher's app gate: a tool that declares `appId` is refused in an
// org with that app switched off, and tools/list hides it for that org.
import { describe, it, expect, afterEach } from 'vitest'
import { url as nuxtUrl } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextUser,
  createContextOrg,
  addTestMembership,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()

const MCP_APPS = ['context', 'messages', 'files', 'feedback', 'inbox', 'crm']
const ALL_SCOPES = [
  'context.read', 'context.write', 'context.portfolio.create', 'context.section.custom',
  'messages.read', 'messages.write', 'files.read', 'files.write', 'feedback.read', 'feedback.write'
]

async function disableApps(orgId: string, appIds: string[]) {
  for (const appId of appIds) {
    await sql`
      INSERT INTO org_apps (org_id, app_id, enabled, source)
      VALUES (${orgId}, ${appId}, false, 'org_admin')
      ON CONFLICT (org_id, app_id) DO UPDATE SET enabled = excluded.enabled
    `
  }
}

async function listToolNames(token: string, activeOrg: string): Promise<string[]> {
  const res = await fetch(nuxtUrl('/mcp'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      'authorization': `Bearer ${token}`,
      'x-active-org': activeOrg
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  const text = await res.text()
  expect(res.status, text).toBe(200)
  const dataLine = text.trim().split('\n').find(l => l.startsWith('data:'))
  const rpc = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : text) as { result: { tools: Array<{ name: string }> } }
  return rpc.result.tools.map(t => t.name)
}

// An admin of org A (every app on) and org B (context off).
async function setupTwoOrgs() {
  const user = await createContextUser(sql)
  const orgA = await createContextOrg(sql)
  const orgB = await createContextOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: orgA.id, roles: ['admin'] })
  await addTestMembership(sql, { user_id: user.id, org_id: orgB.id, roles: ['admin'] })
  await disableApps(orgB.id, ['context'])
  return { user, orgA, orgB }
}

describe('MCP app switch', () => {
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-context-%'`
  })

  it('refuses a read tool in an org with the app off and allows it where the app is on', async () => {
    const { user, orgA, orgB } = await setupTwoOrgs()
    const token = await issueMcpBearer(sql, user.id, ['context.read'])

    const denied = await callMcpTool(token, 'list_portfolios', { org: orgB.slug })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]?.text).toBe('App "context" is not enabled for this organization.')
    expect(denied.structuredContent).toEqual({ error: 'app_disabled', app: 'context', surface: 'org', actionable: 'contact_admin' })

    const allowed = await callMcpTool(token, 'list_portfolios', { org: orgA.slug })
    expect(allowed.isError, allowed.content[0]?.text).toBeFalsy()
  })

  it('refuses a write tool in an org with the app off without touching data', async () => {
    const { user, orgA, orgB } = await setupTwoOrgs()
    const token = await issueMcpBearer(sql, user.id, ['context.portfolio.create'])

    const denied = await callMcpTool(token, 'create_portfolio', { org: orgB.slug, name: 'Blocked' })
    expect(denied.structuredContent?.error).toBe('app_disabled')
    const [blocked] = await sql`SELECT count(*)::int AS n FROM context_portfolios WHERE org_id = ${orgB.id}`
    expect(blocked!.n).toBe(0)

    const created = await callMcpTool(token, 'create_portfolio', { org: orgA.slug, name: 'Allowed' })
    expect(created.isError, created.content[0]?.text).toBeFalsy()
    const [allowed] = await sql`SELECT count(*)::int AS n FROM context_portfolios WHERE org_id = ${orgA.id}`
    expect(allowed!.n).toBe(1)
  })

  it('gates a call with no org on the user\'s only org', async () => {
    const user = await createContextUser(sql)
    const org = await createContextOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })
    await disableApps(org.id, ['context'])
    const token = await issueMcpBearer(sql, user.id, ['context.read'])

    const denied = await callMcpTool(token, 'list_portfolios', {})
    expect(denied.structuredContent?.error).toBe('app_disabled')

    const orgs = await callMcpTool(token, 'list_orgs', {})
    expect(orgs.isError, orgs.content[0]?.text).toBeFalsy()
  })

  it('list_orgs reports each org\'s MCP apps to a token holding any scope', async () => {
    const { user, orgA, orgB } = await setupTwoOrgs()
    const token = await issueMcpBearer(sql, user.id, ['files.read'])

    const res = await callMcpTool(token, 'list_orgs', {})
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const orgs = res.structuredContent?.orgs as Array<{ slug: string, apps: string[] }>
    const appsOf = (slug: string) => orgs.find(o => o.slug === slug)!.apps
    expect(appsOf(orgA.slug)).toContain('context')
    expect(appsOf(orgB.slug)).not.toContain('context')
    for (const app of [...appsOf(orgA.slug), ...appsOf(orgB.slug)]) {
      expect(MCP_APPS).toContain(app)
    }
  })

  it('tools/list hides every app tool for an org with the apps off', async () => {
    const { user, orgA, orgB } = await setupTwoOrgs()
    await disableApps(orgB.id, MCP_APPS)
    const token = await issueMcpBearer(sql, user.id, ALL_SCOPES)

    const inA = await listToolNames(token, orgA.slug)
    expect(inA).toEqual(expect.arrayContaining([
      'list_orgs', 'list_portfolios', 'messages_list_conversations', 'files_list', 'feedback_list_cards'
    ]))

    expect(await listToolNames(token, orgB.slug)).toEqual(['list_orgs'])
  })
})
