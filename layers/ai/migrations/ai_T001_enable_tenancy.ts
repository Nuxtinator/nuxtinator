import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration, included only when the tenancy layer is loaded.
// Adds `org_id` + RLS to the usage log. The helper is inlined because the
// migration runner imports these files outside Nuxt's alias layer.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ai_usage
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`CREATE INDEX ai_usage_org_created_at_idx ON ai_usage (org_id, created_at)`.execute(db)
  await sql`ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON ai_usage FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ai_usage`.execute(db)
  await sql`ALTER TABLE ai_usage DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`DROP INDEX IF EXISTS ai_usage_org_created_at_idx`.execute(db)
  await sql`ALTER TABLE ai_usage DROP COLUMN org_id`.execute(db)
}
