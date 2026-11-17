// Inbox-layer test helpers. Re-exports tenancy + core helpers (same package
// export the crm helpers build on) and adds: org bootstrap with the inbox
// app enabled + its own receiving mail domain, raw-MIME inbound and delivery
// event fixtures signed for the fake mail provider, and prefix-scoped
// cleanup.
//
// All seeded data is prefixed `test-inbox-` (users, org slugs, domains) so
// cleanup stays scoped. inbox_* rows cascade off orgs; channel identity rows
// deliberately survive record deletion (crm registry semantics), so cleanup
// relies on the org cascade wiping org-scoped channels.
import type postgres from 'postgres'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { url as nuxtUrl } from '@nuxt/test-utils/e2e'
import { fakeSignature } from '@nuxtinator/mail/test'
import {
  createTestUser,
  getAuthHeaders,
  withOrgHeader,
  type AuthHeaders,
  type TestUser,
  createTestOrg,
  addTestMembership,
  getHostAdminDb,
  type TestOrg
} from '@nuxtinator/tenancy/test-helpers'

export * from '@nuxtinator/tenancy/test-helpers'
export { waitForMailTo, clearMailhog } from '../../../../core/tests/helpers/mailhog'

export const INBOX_TEST_SIGNING_KEY = 'test-inbox-signing-key'
export const INBOX_TEST_API_KEY = 'test-inbox-api-key'
// The host's inbox domain, routed to the inbox stream by global setup: under
// slug addresses orgs without their own domain receive at <slug>@ it.
export const INBOX_TEST_SHARED_DOMAIN = 'test-inbox-shared.test'

export async function createInboxUser(
  sql: ReturnType<typeof postgres>,
  opts: Parameters<typeof createTestUser>[1] = {}
): Promise<TestUser> {
  return createTestUser(sql, {
    ...opts,
    email: opts.email ?? `test-inbox-${randomUUID().slice(0, 8)}@example.com`
  })
}

// A complete inbox-enabled org: user with the given roles, membership, the
// inbox app enabled (the catalog seeds apps as 'available', so orgs opt in),
// and its own mail domain that can send and receive, routed to its inbox stream.
export async function createInboxOrgWith(
  sql: ReturnType<typeof postgres>,
  roles: string[] = ['admin']
): Promise<{ org: TestOrg, user: TestUser, auth: AuthHeaders, domain: string, opts: ReturnType<typeof withOrgHeader> }> {
  const user = await createInboxUser(sql)
  const org = await createTestOrg(sql, {
    slug: `test-inbox-${randomUUID().slice(0, 8)}`,
    name: 'Test Inbox Org'
  })
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles })

  // A row with no status falls back to the app's code default, which is off.
  await sql`INSERT INTO apps (id, status) VALUES ('inbox', 'available') ON CONFLICT (id) DO UPDATE SET status = coalesce(apps.status, 'available')`
  await sql`INSERT INTO apps (id, status) VALUES ('crm', 'available') ON CONFLICT (id) DO UPDATE SET status = coalesce(apps.status, 'available')`
  await sql`
    INSERT INTO org_apps (org_id, app_id, enabled, source)
    VALUES (${org.id}, 'inbox', true, 'org_admin'), (${org.id}, 'crm', true, 'org_admin')
    ON CONFLICT DO NOTHING
  `

  const domain = `${org.slug}.test`
  await addOrgMailDomain(sql, org.id, domain)

  return { org, user, auth: getAuthHeaders(user), domain, opts: withOrgHeader(getAuthHeaders(user), org.slug) }
}

export async function setInboxOrgSetting(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  key: string,
  value: unknown
): Promise<void> {
  // sql.json — never a pre-stringified param with a bare ::jsonb cast, which
  // double-encodes into a quoted-string scalar (crm dev.md gotcha 1).
  await sql`
    INSERT INTO core_settings (namespace, key, value, org_id)
    VALUES ('inbox', ${key}, ${sql.json(value as never)}, ${orgId})
    ON CONFLICT (org_id, namespace, key)
    DO UPDATE SET value = ${sql.json(value as never)}
  `
}

// --- Mail domains ----------------------------------------------------------

// The fake-provider account global setup creates for the inbox's domains.
export function testMailAccountId(): string {
  const id = process.env.INBOX_TEST_MAIL_ACCOUNT_ID
  if (!id) throw new Error('The inbox global setup did not record its mail account')
  return id
}

// An ownership-verified domain on the test mail account, sending verified
// and receiving as asked, routed to the inbox stream: the org's own (orgId)
// or the host's (null). Org rows cascade with the org; host rows are removed
// by cleanup (their names start with test-inbox-).
export async function addOrgMailDomain(
  sql: ReturnType<typeof postgres>,
  orgId: string | null,
  domain: string,
  opts: { receive?: boolean } = {}
): Promise<string> {
  const account = testMailAccountId()
  const receive = opts.receive ?? true
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO mail_domains (org_id, source, domain, ownership_status, send_account_id, receive_account_id, setup_mode, send_status, receive_status)
    VALUES (${orgId}, 'ui', ${domain}, 'verified', ${account}, ${receive ? account : null}, 'manual', 'verified', ${receive ? 'verified' : 'pending'})
    RETURNING id
  `
  await sql`INSERT INTO mail_stream_routes (org_id, stream, domain_id) VALUES (${orgId}, 'inbox', ${row!.id})`
  return row!.id
}

export async function setMailDomainReceiving(sql: ReturnType<typeof postgres>, domainId: string, receive: boolean): Promise<void> {
  const account = testMailAccountId()
  await sql`
    UPDATE mail_domains
    SET receive_account_id = ${receive ? account : null}, receive_status = ${receive ? 'verified' : 'pending'}
    WHERE id = ${domainId}
  `
}

// The host's inbox domain (INBOX_TEST_SHARED_DOMAIN), set up by global setup.
export function sharedMailDomainId(): string {
  return process.env.INBOX_TEST_SHARED_DOMAIN_ID!
}

// --- Fake-provider webhook fixtures -----------------------------------------

function webhookPath(kind: 'inbound' | 'events'): string {
  const path = process.env[kind === 'inbound' ? 'INBOX_TEST_MAIL_INBOUND_PATH' : 'INBOX_TEST_MAIL_EVENTS_PATH']
  if (!path) throw new Error('The inbox global setup did not record the fake provider webhook URLs')
  return path
}

async function postWebhook(
  kind: 'inbound' | 'events',
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number, body: Record<string, unknown> }> {
  const res = await fetch(nuxtUrl(webhookPath(kind)), {
    method: 'POST',
    headers: { 'x-fake-signature': fakeSignature(INBOX_TEST_SIGNING_KEY, body), ...headers },
    body
  })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  return { status: res.status, body: json }
}

export interface InboundFixtureOpts {
  recipient: string
  from: string
  subject?: string
  text?: string
  html?: string
  messageId?: string
  inReplyTo?: string
  references?: string
  authenticated?: boolean
  // Extra MIME headers, e.g. ['X-Test-Fail', 'persist'] for the
  // persistence-failure seam.
  headers?: [string, string][]
  signatureOverride?: string
  attachments?: { filename: string, contentType: string, content: string }[]
}

function buildMime(f: InboundFixtureOpts, messageId: string): string {
  const alt = `alt-${randomUUID()}`
  const text = f.text ?? 'Test body'
  const html = f.html ?? `<p>${text}</p>`
  const head = [
    `From: ${f.from}`,
    `To: ${f.recipient}`,
    `Subject: ${f.subject ?? 'Test subject'}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-Id: ${messageId}`,
    'MIME-Version: 1.0'
  ]
  if (f.authenticated !== false) head.push('Authentication-Results: mx.test; dkim=pass header.d=sender.example; dmarc=pass')
  if (f.inReplyTo) head.push(`In-Reply-To: ${f.inReplyTo}`)
  if (f.references) head.push(`References: ${f.references}`)
  for (const [k, v] of f.headers ?? []) head.push(`${k}: ${v}`)
  const alternative = [
    `--${alt}`, 'Content-Type: text/plain; charset=utf-8', '', text,
    `--${alt}`, 'Content-Type: text/html; charset=utf-8', '', html,
    `--${alt}--`
  ]
  if (!f.attachments?.length) {
    return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...alternative, ''].join('\r\n')
  }
  const mixed = `mixed-${randomUUID()}`
  const parts = [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...alternative]
  for (const a of f.attachments) {
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(a.content).toString('base64')
    )
  }
  parts.push(`--${mixed}--`)
  return [...head, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', ...parts, ''].join('\r\n')
}

// POST raw MIME to the fake provider's inbound URL, signed with the test
// account's signing key — the kernel's signature check and the inbox handler
// run in every test. `body` reports what the inbox made of it: `status` is
// 'contact' | 'held' | 'spam' | 'duplicate' with the conversation and message,
// or 'ignored' when the mail was dropped; `kernel` is the webhook's own reply.
export async function postInbound(fixture: InboundFixtureOpts): Promise<{ status: number, body: Record<string, unknown>, kernel: Record<string, unknown> }> {
  const messageId = fixture.messageId ?? `<test-inbox-${randomUUID()}@sender.example>`
  const sql = getInboxTestDb()
  const existedBefore = await findInboundMessage(sql, messageId)
  const raw = buildMime(fixture, messageId)
  const res = await postWebhook('inbound', raw, {
    'content-type': 'message/rfc822',
    'x-fake-envelope-to': fixture.recipient,
    ...(fixture.signatureOverride !== undefined ? { 'x-fake-signature': fixture.signatureOverride } : {})
  })
  if (res.status !== 200) return { status: res.status, body: {}, kernel: res.body }
  const recipients = (res.body.recipients ?? []) as { outcome: string }[]
  if (!recipients.some(r => r.outcome === 'handled')) {
    return { status: 200, body: { status: 'ignored' }, kernel: res.body }
  }
  const row = await findInboundMessage(sql, messageId)
  if (!row) return { status: 200, body: { status: 'ignored' }, kernel: res.body }
  const status = existedBefore
    ? 'duplicate'
    : row.message_status === 'held' ? 'held' : row.conversation_status === 'spam' ? 'spam' : 'contact'
  return {
    status: 200,
    body: { status, conversation_id: row.conversation_id, message_id: row.id },
    kernel: res.body
  }
}

async function findInboundMessage(sql: ReturnType<typeof postgres>, messageId: string) {
  const [row] = await sql<{ id: string, conversation_id: string, message_status: string, conversation_status: string }[]>`
    SELECT m.id, m.conversation_id, m.status AS message_status, c.status AS conversation_status
    FROM inbox_messages m JOIN inbox_conversations c ON c.id = m.conversation_id
    WHERE m.email_message_id = ${messageId}
  `
  return row ?? null
}

let _db: ReturnType<typeof postgres> | null = null
function getInboxTestDb(): ReturnType<typeof postgres> {
  _db ??= getHostAdminDb()
  return _db
}

export interface MailEventFixture {
  type: 'delivered' | 'bounced' | 'deferred' | 'complained' | 'unsubscribed' | 'rejected' | 'dropped'
  recipient: string
  permanent?: boolean
  detail?: string
  orgId?: string | null
  ref?: string | null
  stream?: string | null
}

const eventRecipients = new Set<string>()

// POST provider events to the fake provider's events URL, correlated to the
// inbox stream unless told otherwise. Every recipient is remembered so cleanup
// can drop the kernel suppressions the events create.
export async function postMailEvents(events: MailEventFixture[]): Promise<{ status: number, body: Record<string, unknown> }> {
  for (const e of events) eventRecipients.add(e.recipient.trim().toLowerCase())
  const body = JSON.stringify({
    events: events.map(e => ({
      ...e,
      stream: e.stream === undefined ? 'inbox' : e.stream,
      permanent: e.permanent ?? (e.type === 'bounced' || e.type === 'rejected' || e.type === 'dropped'),
      occurredAt: new Date().toISOString()
    }))
  })
  return await postWebhook('events', body, { 'content-type': 'application/json' })
}

export interface SentMail {
  id: string
  from: string
  messageId: string
  inReplyTo: string
  replyTo: string
}

// Mail Mailpit caught for this recipient, newest first, with the headers the
// inbox sets. Waits until at least `count` have arrived.
export async function waitForMailsTo(address: string, count = 1, timeoutMs = 15_000): Promise<SentMail[]> {
  const base = process.env.TEST_MAILHOG_URL || 'http://localhost:8025'
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
    const body = await res.json() as { messages: Array<{ ID: string, To: Array<{ Address: string }> }> }
    const ids = (body.messages ?? [])
      .filter(m => m.To.some(t => t.Address.toLowerCase() === address.toLowerCase()))
      .map(m => m.ID)
    if (ids.length >= count) {
      const out: SentMail[] = []
      for (const id of ids) {
        const h = await (await fetch(`${base}/api/v1/message/${id}/headers`)).json() as Record<string, string[]>
        const header = (name: string) => h[name]?.[0] ?? h[name.toLowerCase()]?.[0] ?? ''
        out.push({ id, from: header('From'), messageId: header('Message-Id') || header('Message-ID'), inReplyTo: header('In-Reply-To'), replyTo: header('Reply-To') })
      }
      return out
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`Fewer than ${count} mails to ${address} arrived within ${timeoutMs}ms`)
}

export function hashMailAddress(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex')
}

// --- Direct S3 assertions ---------------------------------------------------

// The Nuxt server does the uploads/deletes; tests verify the bucket directly
// with their own client. Credentials are forwarded from dev/.env by
// dev/vitest.config.ts. Private objects live in S3_BUCKET_NAME under the keys
// stored in inbox_attachments.s3_key / inbox_messages.raw_s3_key.
let _s3: S3Client | null = null

function getTestS3(): S3Client {
  if (_s3) return _s3
  const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_NAME } = process.env
  if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
    throw new Error('S3_* env not set in the test process — dev/vitest.config.ts forwards it from dev/.env')
  }
  _s3 = new S3Client({
    endPoint: S3_ENDPOINT,
    region: S3_REGION || 'auto',
    bucket: S3_BUCKET_NAME,
    accessKey: S3_ACCESS_KEY_ID,
    secretKey: S3_SECRET_ACCESS_KEY,
    pathStyle: true
  })
  return _s3
}

export async function s3ObjectExists(key: string): Promise<boolean> {
  return await getTestS3().exists(key)
}

// --- MCP over the real /mcp transport ------------------------------------

export interface McpToolResult {
  content: Array<{ type: string, text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export const INBOX_TEST_MCP_CLIENT_NAME = 'test-inbox mcp client'

// Mint an oauth client + token family + access token with the same row shapes
// the token endpoint writes. The token's resource must equal the server's
// mcpResource, read from its RFC 9728 metadata. The client id is
// `test-inbox-` prefixed so cleanup can scope its delete.
export async function issueMcpBearer(
  sql: ReturnType<typeof postgres>,
  userId: string,
  scopes: string[]
): Promise<string> {
  const metaRes = await fetch(nuxtUrl('/.well-known/oauth-protected-resource'))
  const meta = await metaRes.json() as { resource: string }
  const clientId = `test-inbox-${randomBytes(8).toString('hex')}`
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
    VALUES (${clientId}, ${INBOX_TEST_MCP_CLIENT_NAME}, ${['http://localhost/callback']})
  `
  const familyId = randomUUID()
  await sql`
    INSERT INTO oauth_token_families (family_id, user_id, client_id)
    VALUES (${familyId}, ${userId}, ${clientId})
  `
  const token = `oat_${randomBytes(32).toString('hex')}`
  const tokenHash = createHash('sha256').update(token).digest('hex')
  await sql`
    INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, resource, family_id, expires)
    VALUES (${tokenHash}, ${clientId}, ${userId}, ${scopes.join(' ')}, ${meta.resource}, ${familyId}, now() + interval '1 hour')
  `
  return token
}

// One JSON-RPC request over Streamable HTTP. The stateless transport answers
// with an SSE frame; unwrap the data line to the result.
async function mcpRequest<T>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(nuxtUrl('/mcp'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`MCP ${method} returned ${res.status}: ${text}`)
  const dataLine = text.trim().split('\n').find(l => l.startsWith('data:'))
  const rpc = JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : text) as { result?: T, error?: unknown }
  if (rpc.error) throw new Error(`MCP ${method} error: ${JSON.stringify(rpc.error)}`)
  return rpc.result!
}

export async function callMcpTool(token: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  return await mcpRequest<McpToolResult>(token, 'tools/call', { name, arguments: args })
}

export async function listMcpTools(token: string): Promise<Array<{ name: string, annotations?: Record<string, boolean> }>> {
  return (await mcpRequest<{ tools: Array<{ name: string, annotations?: Record<string, boolean> }> }>(token, 'tools/list', {})).tools
}

// --- Cleanup ---------------------------------------------------------------

// Deleting the test orgs cascades every org-scoped row (inbox_*, crm_*,
// core_settings, memberships). Users are wiped by prefix afterwards.
export async function cleanupInboxTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-inbox-%'`
  // Host mail domains made by tests (routes cascade), not the shared one.
  await sql`
    DELETE FROM mail_domains
    WHERE source = 'ui' AND org_id IS NULL AND domain LIKE 'test-inbox-%' AND domain <> ${INBOX_TEST_SHARED_DOMAIN}
  `
  if (eventRecipients.size) {
    await sql`DELETE FROM mail_suppressions WHERE address_hash IN ${sql([...eventRecipients].map(hashMailAddress))}`
    eventRecipients.clear()
  }
  await sql`DELETE FROM users WHERE email LIKE 'test-inbox-%'`
  // OAuth clients minted by `issueMcpBearer`; their token families and
  // access tokens cascade off the users deleted above.
  await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-inbox-%'`
}
