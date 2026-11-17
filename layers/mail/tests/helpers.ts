import { Kysely, sql, type CompiledQuery } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'
import { createMail, memoryDns, type CreateMailOptions, type MailStream } from '../kernel'
import type { MailDatabase } from '../kernel/schema'
import { jsonb } from '../kernel/json'
import { createFakeProvider, type FakeProvider } from '../test'

export const TEST_SCHEMA = 'mail_kernel_test'
export const SECRET = 'a'.repeat(64)
export const OTHER_SECRET = 'b'.repeat(64)

export const queries: string[] = []

let _pg: ReturnType<typeof postgres> | null = null
let _db: Kysely<MailDatabase> | null = null

export function pg() {
  if (!_pg) {
    _pg = postgres(process.env.TEST_DATABASE_URL!, {
      prepare: false,
      onnotice: () => {},
      max: 8,
      connection: { search_path: `${TEST_SCHEMA},public` }
    })
  }
  return _pg
}

export function db(): Kysely<MailDatabase> {
  if (!_db) {
    _db = new Kysely<MailDatabase>({
      dialect: new PostgresJSDialect({ postgres: pg() }),
      log: (e) => {
        if (e.level === 'query') queries.push((e.query as CompiledQuery).sql)
      }
    })
  }
  return _db
}

export async function resetTables(): Promise<void> {
  await sql`TRUNCATE mail_outbox, mail_suppressions, mail_stream_routes, mail_domains, mail_accounts CASCADE`.execute(db())
  queries.length = 0
}

export const STREAMS: MailStream[] = [
  { id: 'account', label: 'Account', defaultLocal: 'noreply', orgAssignable: false, userInitiated: true },
  { id: 'system', label: 'System', defaultLocal: 'noreply', orgAssignable: false },
  { id: 'newsletter', label: 'Newsletter', defaultLocal: 'news', orgAssignable: true, bulk: true },
  { id: 'inbox', label: 'Inbox', defaultLocal: 'contact', orgAssignable: true, needsReceive: true },
  { id: 'queued', label: 'Queued', defaultLocal: 'noreply', orgAssignable: true, queued: true },
  { id: 'reset', label: 'Reset', defaultLocal: 'noreply', orgAssignable: false, queued: true, userInitiated: true }
]

export const ENV = {
  MAIL_PROVIDER: 'fake',
  MAIL_FAKE_API_KEY: 'key-1',
  MAIL_FAKE_SIGNING_KEY: 'sign-1',
  MAIL_DOMAIN: 'mg.example.org',
  SMTP_FROM: 'noreply@example.org',
  SMTP_FROM_NAME: 'Example'
}

export interface Harness {
  mail: ReturnType<typeof createMail>
  fake: FakeProvider
  dns: ReturnType<typeof memoryDns>
}

export function harness(overrides: Partial<CreateMailOptions> & { fake?: FakeProvider } = {}): Harness {
  const fake = overrides.fake ?? createFakeProvider()
  fake.control.deliver = false
  const dns = memoryDns()
  const mail = createMail({
    db: db(),
    providers: [fake],
    streams: STREAMS,
    env: ENV,
    secretKey: SECRET,
    transport: 'provider',
    dns,
    log: () => {},
    ...overrides
  })
  return { mail, fake, dns }
}

export async function orgId(): Promise<string> {
  const res = await sql<{ id: string }>`select gen_random_uuid() as id`.execute(db())
  return res.rows[0]!.id
}

export async function insertDomain(values: Partial<{
  org_id: string | null
  domain: string
  ownership_status: 'verified' | 'pending' | 'lapsed'
  send_account_id: string | null
  receive_account_id: string | null
  send_status: 'pending' | 'verified' | 'failed'
  receive_status: 'pending' | 'verified' | 'failed'
  from_domain: string | null
  credentials: string | null
  capabilities: string | null
  setup_mode: 'auto' | 'manual'
  probe_token: string | null
}>) {
  return await db().insertInto('mail_domains').values({
    org_id: null,
    domain: 'example.net',
    ownership_status: 'verified',
    send_status: 'verified',
    receive_status: 'pending',
    dns_records: jsonb([]),
    provider_refs: jsonb({}),
    ...values,
    capabilities: values.capabilities ? jsonb(JSON.parse(values.capabilities)) : null
  }).returningAll().executeTakeFirstOrThrow()
}

export async function insertAccount(values: Partial<{ org_id: string | null, provider: string, credentials: string | null, capabilities: string }> = {}) {
  return await db().insertInto('mail_accounts').values({
    org_id: null,
    source: 'ui',
    provider: 'fake',
    ...values,
    capabilities: jsonb(values.capabilities ? JSON.parse(values.capabilities) : {})
  }).returningAll().executeTakeFirstOrThrow()
}

export async function route(org: string | null, stream: string, domainId: string) {
  await db().insertInto('mail_stream_routes').values({ org_id: org, stream, domain_id: domainId }).execute()
}

export function mailFor(to: string, extra: Record<string, unknown> = {}) {
  return { stream: 'system', to, subject: 'Hello', html: '<p>Hello</p>', ...extra }
}
