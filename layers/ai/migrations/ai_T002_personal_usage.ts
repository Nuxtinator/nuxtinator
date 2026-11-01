import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration, included only when the tenancy layer is loaded.
// A personal app's AI calls run with a user and no org, so `org_id` is null
// for them (its default reads the unset org setting as null). A row is visible
// to its org, or, when it has no org, to the user who made the call.
const ORG = sql`nullif(current_setting('app.current_org', true), '')::uuid`
const ME = sql`nullif(current_setting('app.current_user', true), '')::uuid`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ai_usage ALTER COLUMN org_id DROP NOT NULL`.execute(db)
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ai_usage`.execute(db)
  const scope = sql`(org_id IS NOT NULL AND org_id = ${ORG}) OR (org_id IS NULL AND user_id = ${ME})`
  await sql`CREATE POLICY ai_usage_scope ON ai_usage FOR ALL USING (${scope}) WITH CHECK (${scope})`.execute(db)
}

// Calls made outside any org can't go back to the org-only log, so they are dropped.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS ai_usage_scope ON ai_usage`.execute(db)
  await sql`DELETE FROM ai_usage WHERE org_id IS NULL`.execute(db)
  await sql`ALTER TABLE ai_usage ALTER COLUMN org_id SET NOT NULL`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON ai_usage FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}
