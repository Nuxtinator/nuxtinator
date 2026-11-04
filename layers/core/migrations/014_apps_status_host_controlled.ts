import { type Kysely, sql } from 'kysely'

// 'host_controlled': each org's on/off is set only by a host admin; org admins
// can't change it. Single-tenant deploys treat it as 'disabled'.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TYPE app_status ADD VALUE IF NOT EXISTS 'host_controlled'`.execute(db)
}

// Postgres can't drop an enum value.
export async function down(): Promise<void> {}
