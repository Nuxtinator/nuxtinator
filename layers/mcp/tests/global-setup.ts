// Vitest globalSetup hook. Truncates the test tables once before the suite so
// each run starts from empty rows. The schema itself is created by core's
// migration runner when the fixture consumer boots, so on a fresh database the
// tables don't exist yet and there is nothing to truncate.
//
// Skips when TEST_DATABASE_URL is unset — unit suite still runs.
import { Kysely, sql } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'

const TABLES = [
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

export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    console.warn('[mcp-layer tests] TEST_DATABASE_URL not set — integration suite will fail / skip')
    return
  }

  const pg = postgres(url, { ssl: false, max: 2, idle_timeout: 5, connect_timeout: 5, onnotice: () => {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new Kysely<any>({ dialect: new PostgresJSDialect({ postgres: pg }) })

  try {
    const existing: string[] = []
    for (const table of TABLES) {
      const { rows } = await sql<{ t: string | null }>`SELECT to_regclass(${`public.${table}`})::text AS t`.execute(db)
      if (rows[0]?.t) existing.push(table)
    }
    if (existing.length > 0) {
      await sql`TRUNCATE ${sql.join(existing.map(t => sql.table(t)))} RESTART IDENTITY CASCADE`.execute(db)
    }
  }
  finally {
    await db.destroy()
  }
}

export async function teardown(): Promise<void> {
  // Nothing to do — per-test cleanup runs via cleanupFixtures().
  // Leaving rows behind would only be visible until the next suite truncates.
}
