import { type Kysely, sql } from 'kysely'

// The OAuth client (e.g. an AI assistant over MCP) a timeline entry or
// comment came through; null for browser requests. No foreign key: the oauth
// layer that owns `oauth_clients` is optional.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE crm_record_activity ADD COLUMN IF NOT EXISTS client_id text`.execute(db)
  await sql`ALTER TABLE crm_record_comments ADD COLUMN IF NOT EXISTS client_id text`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE crm_record_comments DROP COLUMN IF EXISTS client_id`.execute(db)
  await sql`ALTER TABLE crm_record_activity DROP COLUMN IF EXISTS client_id`.execute(db)
}
