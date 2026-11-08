import { type Kysely, sql } from 'kysely'

// org_id + RLS for records_attachments. The trash queue holds only storage
// keys and stays unscoped, so the background sweep can empty it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE records_attachments
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`ALTER TABLE records_attachments ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON records_attachments FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON records_attachments`.execute(db)
  await sql`ALTER TABLE records_attachments DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE records_attachments DROP COLUMN org_id`.execute(db)
}
