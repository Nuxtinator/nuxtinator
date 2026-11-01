import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration, included only when the tenancy layer is loaded.
// Splits the usage log's visibility into the two policy shapes the RLS
// invariant allows: the active org's rows, and rows with no org keyed on the
// user who made the call.
const ORG = sql`nullif(current_setting('app.current_org', true), '')::uuid`
const ME = sql`nullif(current_setting('app.current_user', true), '')::uuid`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS ai_usage_scope ON ai_usage`.execute(db)
  await sql`CREATE POLICY tenant_isolation ON ai_usage FOR ALL USING (org_id = ${ORG}) WITH CHECK (org_id = ${ORG})`.execute(db)
  await sql`
    CREATE POLICY personal_user ON ai_usage FOR ALL
      USING       (org_id IS NULL AND user_id = ${ME})
      WITH CHECK  (org_id IS NULL AND user_id = ${ME})
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS personal_user ON ai_usage`.execute(db)
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ai_usage`.execute(db)
  const scope = sql`(org_id IS NOT NULL AND org_id = ${ORG}) OR (org_id IS NULL AND user_id = ${ME})`
  await sql`CREATE POLICY ai_usage_scope ON ai_usage FOR ALL USING (${scope}) WITH CHECK (${scope})`.execute(db)
}
