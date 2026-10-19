// Inbox-layer test helpers. Re-exports tenancy + core helpers (same package
// export the crm helpers build on) and adds: org bootstrap with the inbox
// app enabled + a claimed inbound domain, a signed Mailgun webhook fixture
// builder, and prefix-scoped cleanup.
//
// All seeded data is prefixed `test-inbox-` (users, org slugs, domains) so
// cleanup stays scoped. inbox_* rows cascade off orgs; channel identity rows
// deliberately survive record deletion (crm registry semantics), so cleanup
// relies on the org cascade wiping org-scoped channels.
import type postgres from 'postgres'
import { createHmac, randomUUID } from 'node:crypto'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  createTestUser,
  getAuthHeaders,
  withOrgHeader,
  type AuthHeaders,
  type TestUser,
  createTestOrg,
  addTestMembership,
  type TestOrg
} from '@nuxtinator/tenancy/test-helpers'

export * from '@nuxtinator/tenancy/test-helpers'
export { waitForMailTo, clearMailhog } from '../../../../core/tests/helpers/mailhog'

export const INBOX_TEST_SIGNING_KEY = 'test-inbox-signing-key'
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
// and a unique inbound domain claimed via the settings override.
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

  await sql`INSERT INTO apps (id, status) VALUES ('inbox', 'available') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO apps (id, status) VALUES ('crm', 'available') ON CONFLICT (id) DO NOTHING`
  await sql`
    INSERT INTO org_apps (org_id, app_id, enabled, source)
    VALUES (${org.id}, 'inbox', true, 'org_admin'), (${org.id}, 'crm', true, 'org_admin')
    ON CONFLICT DO NOTHING
  `

  const domain = `${org.slug}.test`
  await setInboxOrgSetting(sql, org.id, 'inbound_domain', domain)
  await setInboxOrgSetting(sql, org.id, 'contact_address', `contact@${domain}`)

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

// --- Signed Mailgun webhook fixtures -------------------------------------

function signedFields(): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const token = randomUUID().replace(/-/g, '')
  const signature = createHmac('sha256', INBOX_TEST_SIGNING_KEY)
    .update(timestamp + token)
    .digest('hex')
  return { timestamp, token, signature }
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
  headers?: [string, string][]
  signatureOverride?: string
  // Raw MIME source. When present the webhook archives it to S3 and sets
  // `inbox_messages.raw_s3_key`.
  bodyMime?: string
  // Extra top-level form fields (e.g. the x-test-fail persistence seam).
  extraFields?: Record<string, string>
}

// POST a Mailgun-shaped inbound payload. The signature is computed with the
// real signing key — verification code runs in every test.
export async function postInbound(fixture: InboundFixtureOpts): Promise<{ status: number, body: Record<string, unknown> }> {
  const headers: [string, string][] = [
    ['Message-Id', fixture.messageId ?? `<test-inbox-${randomUUID()}@sender.example>`],
    ['Date', new Date().toUTCString()]
  ]
  if (fixture.authenticated !== false) {
    headers.push(['Authentication-Results', 'mx.test; dkim=pass header.d=sender.example; dmarc=pass'])
  }
  if (fixture.inReplyTo) headers.push(['In-Reply-To', fixture.inReplyTo])
  if (fixture.references) headers.push(['References', fixture.references])
  for (const h of fixture.headers ?? []) headers.push(h)

  const sig = signedFields()
  if (fixture.signatureOverride !== undefined) sig.signature = fixture.signatureOverride

  const form = new FormData()
  for (const [k, v] of Object.entries(sig)) form.append(k, v)
  form.append('recipient', fixture.recipient)
  form.append('from', fixture.from)
  form.append('subject', fixture.subject ?? 'Test subject')
  form.append('stripped-text', fixture.text ?? 'Test body')
  form.append('body-html', fixture.html ?? `<p>${fixture.text ?? 'Test body'}</p>`)
  form.append('stripped-html', fixture.html ?? `<p>${fixture.text ?? 'Test body'}</p>`)
  form.append('message-headers', JSON.stringify(headers))
  if (fixture.bodyMime) form.append('body-mime', fixture.bodyMime)
  for (const [k, v] of Object.entries(fixture.extraFields ?? {})) form.append(k, v)

  try {
    const body = await $fetch<Record<string, unknown>>('/api/inbox/webhooks/mailgun/inbound', {
      method: 'POST',
      body: form
    })
    return { status: 200, body }
  } catch (err) {
    const e = err as { statusCode?: number, response?: { status?: number } }
    return { status: e.statusCode ?? e.response?.status ?? 0, body: {} }
  }
}

export async function postDeliveryEvent(eventData: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await $fetch<Record<string, unknown>>('/api/inbox/webhooks/mailgun/events', {
    method: 'POST',
    body: { signature: signedFields(), 'event-data': eventData }
  })
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

// --- Cleanup ---------------------------------------------------------------

// Deleting the test orgs cascades every org-scoped row (inbox_*, crm_*,
// core_settings, memberships). Users are wiped by prefix afterwards.
export async function cleanupInboxTestData(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DELETE FROM orgs WHERE slug LIKE 'test-inbox-%'`
  await sql`DELETE FROM users WHERE email LIKE 'test-inbox-%'`
}
