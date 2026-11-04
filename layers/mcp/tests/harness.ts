// Integration test harness for the MCP layer. Drives the fixture consumer
// at `tests/fixtures/consumer/` over a live Postgres at $TEST_DATABASE_URL.
//
// Architecture: the fixture consumer boots in its own Node process via
// @nuxt/test-utils/e2e. The harness runs in the Vitest process and talks to
// the *same* Postgres directly (own Kysely + postgres-js client). It never
// imports the fixture's runtime — they share schema, not modules.
//
// Provides:
//   - createTestUser({ permissions, verified, roles })
//   - createTestClient({ enabled, redirectUris })
//   - issueTestToken({ userId, clientId, scopes, ... })
//   - fixtureToken({ scopes, permissions })   — convenience composite
//   - callMcp({ method, params, token, headers, httpMethod })
//   - cleanupFixtures()                       — per-test FK-safe row removal
import crypto from 'node:crypto'
import { Kysely, sql } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'
import { url as nuxtUrl } from '@nuxt/test-utils/e2e'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>

let _harnessDb: AnyDb | null = null

function getHarnessDb(): AnyDb {
  if (_harnessDb) return _harnessDb
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL must be set for the integration suite')
  _harnessDb = new Kysely({
    dialect: new PostgresJSDialect({
      postgres: postgres(url, {
        ssl: false,
        max: 5,
        idle_timeout: 5,
        connect_timeout: 5,
        onnotice: () => {}
      })
    })
  })
  return _harnessDb
}

export async function destroyHarnessDb(): Promise<void> {
  if (_harnessDb) {
    await _harnessDb.destroy()
    _harnessDb = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracked fixture rows for cleanup
// ─────────────────────────────────────────────────────────────────────────────

interface TrackedRow {
  table: string
  col: string
  val: string
}

const _tracked: TrackedRow[] = []

function track(table: string, col: string, val: string): void {
  _tracked.push({ table, col, val })
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateTestUserOpts {
  permissions?: string[]
  verified?: boolean
  roles?: string[]
}
export interface CreateTestUserResult { userId: string }

export interface CreateTestClientOpts {
  enabled?: boolean
  redirectUris?: string[]
}
export interface CreateTestClientResult { clientId: string }

export interface IssueTestTokenOpts {
  userId: string
  clientId: string
  scopes: string[]
  resource?: string
  expiresInMs?: number
  revoked?: boolean
}
export interface IssueTestTokenResult {
  token: string
  tokenId: string
  familyId: string
}

export interface CallMcpOpts {
  method?: string
  params?: unknown
  token?: string
  headers?: Record<string, string>
  httpMethod?: 'GET' | 'POST' | 'DELETE'
  // Override the body entirely (e.g. for body-size and JSON-parse tests).
  rawBody?: string
}

export interface JsonRpcResponse {
  jsonrpc?: '2.0'
  id?: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface CallMcpResponse {
  status: number
  headers: Record<string, string>
  body: JsonRpcResponse | string | null
}

export interface TestFixture extends CreateTestUserResult, CreateTestClientResult, IssueTestTokenResult {}

// ─────────────────────────────────────────────────────────────────────────────
// Role lookup (mirrors the roles the fixture's Nitro plugin registers)
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_PERMS: Record<string, string[]> = {
  reader: ['pages.view'],
  writer: ['pages.view', 'pages.write'],
  publisher: ['pages.view', 'pages.write', 'pages.publish']
}

function pickRoleForPermissions(permissions: readonly string[]): string {
  const set = new Set(permissions)
  if (set.size === 0) return ''
  // Smallest exact match wins.
  for (const role of ['reader', 'writer', 'publisher']) {
    const grants = new Set(ROLE_PERMS[role])
    if (grants.size !== set.size) continue
    let exact = true
    for (const p of set) if (!grants.has(p)) { exact = false; break }
    if (exact) return role
  }
  // Otherwise smallest superset.
  for (const role of ['reader', 'writer', 'publisher']) {
    const grants = new Set(ROLE_PERMS[role])
    let covers = true
    for (const p of set) if (!grants.has(p)) { covers = false; break }
    if (covers) return role
  }
  throw new Error(`No fixture role covers permissions: ${[...set].join(', ')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// createTestUser
// ─────────────────────────────────────────────────────────────────────────────

const HARNESS_RUN_ID = crypto.randomBytes(4).toString('hex')

export async function createTestUser(opts: CreateTestUserOpts = {}): Promise<CreateTestUserResult> {
  const db = getHarnessDb()
  const id = crypto.randomUUID()
  const email = `harness-${HARNESS_RUN_ID}-${id.slice(0, 8)}@test.local`

  const roles = opts.roles
    ?? (opts.permissions && opts.permissions.length > 0
      ? [pickRoleForPermissions(opts.permissions)]
      : [])

  await db
    .insertInto('users')
    .values({
      id,
      email,
      display_name: `harness ${id.slice(0, 8)}`,
      verified: opts.verified ?? true,
      roles
    })
    .execute()

  track('users', 'id', id)
  return { userId: id }
}

// ─────────────────────────────────────────────────────────────────────────────
// createTestClient
// ─────────────────────────────────────────────────────────────────────────────

export async function createTestClient(opts: CreateTestClientOpts = {}): Promise<CreateTestClientResult> {
  const db = getHarnessDb()
  const clientId = `mcp_test_${crypto.randomBytes(8).toString('hex')}`

  await db
    .insertInto('oauth_clients')
    .values({
      client_id: clientId,
      client_name: `harness-${HARNESS_RUN_ID}`,
      redirect_uris: opts.redirectUris ?? ['http://localhost:3099/oauth/callback'],
      enabled: opts.enabled ?? true,
      dynamic: true
    })
    .execute()

  track('oauth_clients', 'client_id', clientId)
  return { clientId }
}

// ─────────────────────────────────────────────────────────────────────────────
// issueTestToken — implemented inline so the harness doesn't depend on the
// OAuth layer's modules at import time (the layer's oauth-test.ts imports
// ~~/server/utils/database which only resolves inside the fixture's process).
// Schema and shape match __createAccessTokenForTest exactly.
// ─────────────────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function newAccessToken(): string {
  return `oat_${crypto.randomBytes(32).toString('hex')}`
}

export async function issueTestToken(opts: IssueTestTokenOpts): Promise<IssueTestTokenResult> {
  const db = getHarnessDb()
  const familyId = crypto.randomUUID()
  const plaintext = newAccessToken()
  const resource = opts.resource ?? defaultResource()
  const expiresInMs = opts.expiresInMs ?? 60 * 60 * 1000

  const result = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('oauth_token_families')
      .values({
        family_id: familyId,
        user_id: opts.userId,
        client_id: opts.clientId,
        revoked: opts.revoked ?? false
      })
      .execute()

    const inserted = await trx
      .insertInto('oauth_access_tokens')
      .values({
        token_hash: sha256Hex(plaintext),
        client_id: opts.clientId,
        user_id: opts.userId,
        scope: opts.scopes.join(' '),
        resource,
        family_id: familyId,
        expires: sql`now() + interval '${sql.raw(String(Math.ceil(expiresInMs / 1000)))} seconds'`,
        revoked: opts.revoked ?? false
      })
      .returning(['id'])
      .executeTakeFirstOrThrow()

    return { tokenId: inserted.id as string }
  })

  track('oauth_access_tokens', 'id', result.tokenId)
  track('oauth_token_families', 'family_id', familyId)

  return { token: plaintext, tokenId: result.tokenId, familyId }
}

function defaultResource(): string {
  // Must match the fixture consumer's `runtimeConfig.public.siteUrl + '/mcp'`.
  return (process.env.NUXT_PUBLIC_SITE_URL ?? 'http://localhost:3099') + '/mcp'
}

// ─────────────────────────────────────────────────────────────────────────────
// fixtureToken — convenience composite
// ─────────────────────────────────────────────────────────────────────────────

export async function fixtureToken(opts: { scopes: string[]; permissions: string[] }): Promise<TestFixture> {
  const { userId } = await createTestUser({ permissions: opts.permissions })
  const { clientId } = await createTestClient()
  const issued = await issueTestToken({ userId, clientId, scopes: opts.scopes })
  return { userId, clientId, ...issued }
}

// ─────────────────────────────────────────────────────────────────────────────
// callMcp
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROTOCOL_VERSION = '2025-11-25'

export async function callMcp(opts: CallMcpOpts): Promise<CallMcpResponse> {
  const httpMethod = opts.httpMethod ?? 'POST'

  let body: string | undefined
  if (opts.rawBody !== undefined) {
    body = opts.rawBody
  }
  else if (httpMethod === 'POST' && opts.method) {
    body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: opts.method, params: opts.params })
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.method !== 'initialize' && httpMethod === 'POST' && opts.method) {
    headers['mcp-protocol-version'] = DEFAULT_PROTOCOL_VERSION
  }
  Object.assign(headers, opts.headers ?? {})

  // Use the raw global fetch against the booted server's URL — ofetch and
  // @nuxt/test-utils' wrapped helpers eat the response body in ways that
  // break Streamable-HTTP/SSE responses. We just want raw access.
  const fullUrl = nuxtUrl('/mcp')

  let response: Response
  try {
    response = await globalThis.fetch(fullUrl, {
      method: httpMethod,
      headers,
      body
    })
  }
  catch (err) {
    return { status: 500, headers: {}, body: `network error: ${(err as Error).message}` }
  }

  const responseHeaders: Record<string, string> = {}
  for (const [k, v] of response.headers.entries()) {
    responseHeaders[k.toLowerCase()] = v
  }

  const text = await response.text()
  let parsedBody: JsonRpcResponse | string | null = null
  if (text === '') {
    parsedBody = null
  }
  else {
    const trimmed = text.trim()
    if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
      const dataLine = trimmed.split('\n').find(l => l.startsWith('data:'))
      if (dataLine) {
        try { parsedBody = JSON.parse(dataLine.slice('data:'.length).trim()) as JsonRpcResponse }
        catch { parsedBody = text }
      }
      else { parsedBody = text }
    }
    else {
      try { parsedBody = JSON.parse(text) as JsonRpcResponse }
      catch { parsedBody = text }
    }
  }

  return { status: response.status, headers: responseHeaders, body: parsedBody }
}

// ─────────────────────────────────────────────────────────────────────────────
// cleanupFixtures
// ─────────────────────────────────────────────────────────────────────────────

const CLEANUP_ORDER: string[] = [
  'oauth_refresh_tokens',
  'oauth_access_tokens',
  'oauth_authorization_codes',
  'oauth_pending_requests',
  'oauth_consents',
  'oauth_token_families',
  'oauth_clients',
  'activity_logs',
  'users'
]

export async function cleanupFixtures(): Promise<void> {
  const db = getHarnessDb()

  // Sweep MCP-source activity_logs from the test (mcpLog stamps source='mcp').
  await db
    .deleteFrom('activity_logs')
    .where(sql`metadata->>'source'`, '=', 'mcp')
    .execute()

  for (const table of CLEANUP_ORDER) {
    const rows = _tracked.filter(t => t.table === table)
    if (rows.length === 0) continue
    const cols = new Set(rows.map(r => r.col))
    for (const col of cols) {
      const vals = rows.filter(r => r.col === col).map(r => r.val)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.deleteFrom(table as any).where(col as any, 'in', vals).execute()
    }
  }
  _tracked.length = 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: read the activity_logs rows the test produced. Useful for
// asserting on the audit-log shape the layer emits.
// ─────────────────────────────────────────────────────────────────────────────

export async function listMcpActivityLogs(filter: { tool?: string; userId?: string } = {}): Promise<Array<Record<string, unknown>>> {
  const db = getHarnessDb()
  let q = db
    .selectFrom('activity_logs')
    .selectAll()
    .where(sql`metadata->>'source'`, '=', 'mcp')
    .orderBy('timestamp', 'asc')
  if (filter.tool) q = q.where(sql`metadata->>'tool'`, '=', filter.tool)
  if (filter.userId) q = q.where('user_id', '=', filter.userId)
  return await q.execute() as Array<Record<string, unknown>>
}
