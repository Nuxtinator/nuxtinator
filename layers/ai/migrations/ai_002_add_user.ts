import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Who made each AI call, when it ran as a user (`app.current_user` set), so a
// personal app's spend, which belongs to no org, is still attributed. Null
// once the user is deleted; the spend stays in the log.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ai_usage ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL`.execute(db)
  await sql`CREATE INDEX ai_usage_user_created_at_idx ON ai_usage (user_id, created_at)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS ai_usage_user_created_at_idx`.execute(db)
  await sql`ALTER TABLE ai_usage DROP COLUMN user_id`.execute(db)
}
