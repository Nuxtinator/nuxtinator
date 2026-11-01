import { type Kysely, sql } from 'kysely'

// The OAuth client an action came through; null for browser and native-login
// requests. No foreign key: the oauth layer that owns `oauth_clients` is
// optional.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS client_id text`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS activity_logs_client_idx ON activity_logs (client_id) WHERE client_id IS NOT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS activity_logs_client_idx`.execute(db)
  await sql`ALTER TABLE activity_logs DROP COLUMN IF EXISTS client_id`.execute(db)
}
