import { type Kysely, sql } from 'kysely'

// 'admins': a personal app open only to host admins. Org apps don't take it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TYPE app_status ADD VALUE IF NOT EXISTS 'admins'`.execute(db)
}

// Postgres can't drop an enum value.
export async function down(): Promise<void> {}
