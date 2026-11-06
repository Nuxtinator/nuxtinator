import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration, included only when the tenancy layer is loaded.
// Org transactions carry the caller in `app.current_user`, so a personal-app
// row (no org) is visible only while no org is set. Inside an org transaction
// every row is the org's, and an org's spend never includes its members'
// personal-app spend.
const ORG = sql`nullif(current_setting('app.current_org', true), '')`
const ME = sql`nullif(current_setting('app.current_user', true), '')::uuid`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS personal_user ON ai_usage`.execute(db)
  await sql`
    CREATE POLICY personal_user ON ai_usage FOR ALL
      USING       (org_id IS NULL AND user_id = ${ME} AND ${ORG} IS NULL)
      WITH CHECK  (org_id IS NULL AND user_id = ${ME} AND ${ORG} IS NULL)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS personal_user ON ai_usage`.execute(db)
  await sql`
    CREATE POLICY personal_user ON ai_usage FOR ALL
      USING       (org_id IS NULL AND user_id = ${ME})
      WITH CHECK  (org_id IS NULL AND user_id = ${ME})
  `.execute(db)
}
