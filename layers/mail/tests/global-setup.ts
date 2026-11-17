// The `mail` vitest project tests the kernel without Nuxt. It runs core's
// mail migrations into its own schema (`mail_kernel_test`, with `public`
// behind it for `users`), so it never touches the tables the Nuxt-booted
// projects migrate.
import { Kysely, sql } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'
import { up as up023 } from '../../core/migrations/023_create_mail_tables'
import { up as up024 } from '../../core/migrations/024_create_mail_outbox'
import { up as up025 } from '../../core/migrations/025_mail_suppression_function'

export const TEST_SCHEMA = 'mail_kernel_test'

export async function setup() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL must be set in dev/.env. Run scripts/setup-test-db.sh.')
  const admin = postgres(url, { prepare: false, onnotice: () => {}, max: 1 })
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE; CREATE SCHEMA ${TEST_SCHEMA}`)
  await admin.end()

  const db = new Kysely<unknown>({
    dialect: new PostgresJSDialect({
      postgres: postgres(url, { prepare: false, onnotice: () => {}, max: 1, connection: { search_path: `${TEST_SCHEMA},public` } })
    })
  })
  await up023(db)
  await up024(db)
  await up025(db)
  await sql`select 1`.execute(db)
  await db.destroy()
}

export async function teardown() {
  const url = process.env.TEST_DATABASE_URL!
  const admin = postgres(url, { prepare: false, onnotice: () => {}, max: 1 })
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`)
  await admin.end()
}
