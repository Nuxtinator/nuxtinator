import { type Kysely, sql } from 'kysely'

// Per-app tenancy retrofit for context_section_chunks (runs only when the
// tenancy layer is loaded). Same shape as context_T010.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE context_section_chunks
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`ALTER TABLE context_section_chunks ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON context_section_chunks FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON context_section_chunks`.execute(db)
  await sql`ALTER TABLE context_section_chunks DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE context_section_chunks DROP COLUMN org_id`.execute(db)
}
