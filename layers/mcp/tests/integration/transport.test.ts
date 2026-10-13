// Integration tests for the /mcp transport boundary. Boots the fixture
// consumer at `../fixtures/consumer/` and exercises the real route handler
// against a live Postgres at $TEST_DATABASE_URL.
//
// Set TEST_DATABASE_URL before running, e.g.:
//   TEST_DATABASE_URL=postgres://jd@localhost:5432/mcp_layer_test npm test
//
// Each test cleans up the rows it created via cleanupFixtures(). The
// fixture consumer's runtime registers a known set of tools (see
// fixtures/consumer/server/mcp-tools/all.ts) for the dispatcher tests.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { setup } from '@nuxt/test-utils/e2e'
import {
  fixtureToken,
  createTestUser,
  createTestClient,
  issueTestToken,
  callMcp,
  cleanupFixtures,
  destroyHarnessDb,
  listMcpActivityLogs
} from '../harness'

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/consumer', import.meta.url))

describe('/mcp transport (integration)', async () => {
  await setup({
    rootDir: FIXTURE_ROOT,
    server: true,
    browser: false,
    runner: 'vitest',
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      NUXT_PUBLIC_SITE_URL: process.env.NUXT_PUBLIC_SITE_URL ?? 'http://localhost:3099',
      OAUTH_CONSENT_COOKIE_SECRET: 'test-secret-32-bytes-of-random-stuff-for-integration-suite-padding'
    }
  })

  afterEach(async () => {
    await cleanupFixtures()
  })

  afterAll(async () => {
    await destroyHarnessDb()
  })

  // ── Transport-level guards ─────────────────────────────────────────────

  it('GET /mcp returns 405 with Allow: POST', async () => {
    const res = await callMcp({ httpMethod: 'GET' })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('DELETE /mcp returns 405', async () => {
    const res = await callMcp({ httpMethod: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('POST without bearer returns 401', async () => {
    const res = await callMcp({ method: 'tools/list' })
    expect(res.status).toBe(401)
  })

  it('POST with hostile Origin returns 403', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      method: 'tools/list',
      token: fx.token,
      headers: { origin: 'https://attacker.example.org' }
    })
    expect(res.status).toBe(403)
  })

  it('POST with body > 2 MB returns 413', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    const res = await callMcp({
      token: fx.token,
      rawBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: big } }),
      headers: { 'mcp-protocol-version': '2025-11-25' }
    })
    expect(res.status).toBe(413)
  })

  it('post-initialize POST without MCP-Protocol-Version is accepted', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      token: fx.token,
      rawBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: {} // explicitly omit mcp-protocol-version
    })
    expect(res.status).toBe(200)
  })

  it('POST with an unsupported MCP-Protocol-Version returns 400', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      token: fx.token,
      rawBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'mcp-protocol-version': '1999-01-01' }
    })
    expect(res.status).toBe(400)
  })

  it('POST with malformed JSON returns 400', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      token: fx.token,
      rawBody: '{not valid json',
      headers: { 'mcp-protocol-version': '2025-11-25' }
    })
    expect(res.status).toBe(400)
  })

  // ── tools/list filtering ───────────────────────────────────────────────

  it('tools/list shows only tools the caller can call (scope ∩ RBAC)', async () => {
    const fx = await fixtureToken({
      scopes: ['pages.view'],
      permissions: ['pages.view']
    })
    const res = await callMcp({ method: 'tools/list', token: fx.token })
    expect(res.status).toBe(200)
    const result = (res.body as { result?: { tools?: Array<{ name: string, title?: string }> } }).result
    const names = (result?.tools ?? []).map(t => t.name).sort()
    // Only the pages.view tools are visible — write/destructive scopes hidden.
    expect(names).toEqual(['expensive_thing', 'failing_tool', 'list_pages', 'output_check'])
    expect(result?.tools?.find(t => t.name === 'list_pages')?.title).toBe('List Pages')
    expect(result?.tools?.find(t => t.name === 'output_check')).not.toHaveProperty('title')
  })

  it('tools/list hides a tool whose scope the user has but the token does not', async () => {
    // Token only carries pages.view; user has full admin (pages.write etc.)
    const { userId } = await createTestUser({ permissions: ['pages.view', 'pages.write'] })
    const { clientId } = await createTestClient()
    const { token } = await issueTestToken({
      userId,
      clientId,
      scopes: ['pages.view'] // narrower than user's permissions
    })
    const res = await callMcp({ method: 'tools/list', token })
    const result = (res.body as { result?: { tools?: Array<{ name: string }> } }).result
    const names = (result?.tools ?? []).map(t => t.name)
    expect(names).not.toContain('create_page')
  })

  // ── tools/call gates ───────────────────────────────────────────────────

  it('tools/call with token missing the scope returns insufficient_scope isError', async () => {
    // Give the user the permission so RBAC passes, but issue a token without
    // the required scope. This isolates the gate-2 (token scope) failure.
    const { userId } = await createTestUser({ permissions: ['pages.view', 'pages.write'] })
    const { clientId } = await createTestClient()
    const { token } = await issueTestToken({
      userId,
      clientId,
      scopes: ['pages.view'] // missing pages.write
    })

    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'create_page', arguments: { slug: 'x' } },
      token
    })
    expect(res.status).toBe(200)
    const body = res.body as { result?: { isError?: boolean; structuredContent?: { error?: string; surface?: string; actionable?: string } } }
    expect(body.result?.isError).toBe(true)
    expect(body.result?.structuredContent?.error).toBe('insufficient_scope')
    expect(body.result?.structuredContent?.surface).toBe('token')
    expect(body.result?.structuredContent?.actionable).toBe('re_authorize')
  })

  it('tools/call with user RBAC missing the scope returns insufficient_permission isError', async () => {
    // Give the token the scope but leave the user without the RBAC perm.
    // This isolates the gate-3 (RBAC) failure path that re-authorization
    // CANNOT fix — only an admin grant can.
    const { userId } = await createTestUser({ permissions: ['pages.view'] })
    const { clientId } = await createTestClient()
    const { token } = await issueTestToken({
      userId,
      clientId,
      scopes: ['pages.view', 'pages.write'] // token has it; user doesn't
    })
    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'create_page', arguments: { slug: 'x' } },
      token
    })
    expect(res.status).toBe(200)
    const body = res.body as { result?: { isError?: boolean; structuredContent?: { error?: string; surface?: string; actionable?: string } } }
    expect(body.result?.isError).toBe(true)
    expect(body.result?.structuredContent?.error).toBe('insufficient_permission')
    expect(body.result?.structuredContent?.surface).toBe('rbac')
    expect(body.result?.structuredContent?.actionable).toBe('contact_admin')
  })

  // ── Output validation ──────────────────────────────────────────────────

  it('handler returning malformed structuredContent yields a generic isError', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'output_check', arguments: { malformed: true } },
      token: fx.token
    })
    expect(res.status).toBe(200)
    const body = res.body as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toMatch(/malformed output/i)
    // Must not echo the bad payload.
    expect(body.result?.content?.[0]?.text).not.toMatch(/not-a-number/)
  })

  it('handler returning valid structuredContent passes through', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'output_check', arguments: { malformed: false } },
      token: fx.token
    })
    const body = res.body as { result?: { isError?: boolean; structuredContent?: { ok: boolean; value: number } } }
    expect(body.result?.isError).toBeFalsy()
    expect(body.result?.structuredContent).toEqual({ ok: true, value: 1 })
  })

  it('structuredContent is also returned serialized as a trailing text block', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'output_check', arguments: { malformed: false } },
      token: fx.token
    })
    const body = res.body as { result?: { content?: Array<{ type: string; text: string }>; structuredContent?: unknown } }
    const content = body.result?.content ?? []
    expect(content).toHaveLength(2)
    expect(content[0]?.text).toBe('ok')
    expect(content[1]?.type).toBe('text')
    expect(JSON.parse(content[1]!.text)).toEqual(body.result?.structuredContent)
  })

  it('authorization errors also return their payload serialized as a text block', async () => {
    const { userId } = await createTestUser({ permissions: ['pages.view', 'pages.write'] })
    const { clientId } = await createTestClient()
    const { token } = await issueTestToken({ userId, clientId, scopes: ['pages.view'] })
    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'create_page', arguments: { slug: 'x' } },
      token
    })
    const body = res.body as { result?: { content?: Array<{ text: string }>; structuredContent?: unknown } }
    const content = body.result?.content ?? []
    expect(content).toHaveLength(2)
    expect(content[0]?.text).toMatch(/insufficient scope/i)
    expect(JSON.parse(content[1]!.text)).toEqual(body.result?.structuredContent)
  })

  // ── Error mapping ──────────────────────────────────────────────────────

  it('tools/call with handler throwing 404 maps to isError "<entity> not found"', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'failing_tool', arguments: {} },
      token: fx.token
    })
    const body = res.body as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toBe('page not found')
  })

  // ── mcpLog audit ───────────────────────────────────────────────────────

  it('a successful write tool emits an mcp-source activity_logs row', async () => {
    const fx = await fixtureToken({
      scopes: ['pages.view', 'pages.write'],
      permissions: ['pages.view', 'pages.write']
    })
    const res = await callMcp({
      method: 'tools/call',
      params: { name: 'create_page', arguments: { slug: 'audit-test' } },
      token: fx.token
    })
    expect(res.status).toBe(200)
    const body = res.body as { result?: { isError?: boolean } }
    expect(body.result?.isError).toBeFalsy()

    const rows = await listMcpActivityLogs({ tool: 'create_page', userId: fx.userId })
    expect(rows).toHaveLength(1)
    const row = rows[0] as { event_type: string; user_id: string; metadata: Record<string, unknown> }
    expect(row.event_type).toBe('CREATE')
    expect(row.user_id).toBe(fx.userId)
    expect(row.metadata).toMatchObject({
      source: 'mcp',
      client_id: fx.clientId,
      tool: 'create_page',
      scope: 'pages.write',
      slug: 'audit-test'
    })
  })

  // ── Rate limit ─────────────────────────────────────────────────────────

  it('per-tool rate limit returns isError after the limit is hit', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })

    // First call passes (limit=1, windowMs=60_000).
    const ok = await callMcp({
      method: 'tools/call',
      params: { name: 'expensive_thing', arguments: {} },
      token: fx.token
    })
    expect((ok.body as { result?: { isError?: boolean } }).result?.isError).toBeFalsy()

    // Second call should fail with isError, NOT HTTP 429.
    const blocked = await callMcp({
      method: 'tools/call',
      params: { name: 'expensive_thing', arguments: {} },
      token: fx.token
    })
    expect(blocked.status).toBe(200) // still 200 — error is in the JSON-RPC envelope
    const body = blocked.body as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toMatch(/rate limit exceeded/i)
    expect(body.result?.content?.[0]?.text).toMatch(/expensive_thing/i)
  })

  // ── initialize handshake ───────────────────────────────────────────────

  it('initialize succeeds with a valid bearer', async () => {
    const fx = await fixtureToken({ scopes: ['pages.view'], permissions: ['pages.view'] })
    const res = await callMcp({
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'integration-harness', version: '0.0.0' }
      },
      token: fx.token
    })
    expect(res.status).toBe(200)
    const body = res.body as { result?: { serverInfo?: { name: string; version: string } } }
    expect(body.result?.serverInfo?.name).toBe('mcp-fixture-consumer')
  })
})
