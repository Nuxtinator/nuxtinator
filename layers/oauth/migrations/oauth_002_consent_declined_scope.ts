import { type Kysely, sql } from 'kysely'

// Scopes the user unticked on the consent screen, so a client asking for them
// again doesn't bring the screen back. Space-separated, like `scope`.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oauth_consents ADD COLUMN IF NOT EXISTS declined_scope text NOT NULL DEFAULT ''`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oauth_consents DROP COLUMN IF EXISTS declined_scope`.execute(db)
}
