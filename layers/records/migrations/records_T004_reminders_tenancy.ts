import { type Kysely, sql } from 'kysely'

// org_id + RLS for records_reminders. Rows the table already holds take the
// org of their record.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE records_reminders
      ADD COLUMN org_id uuid REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`
    UPDATE records_reminders r SET org_id = e.org_id
    FROM records_entries e WHERE e.id = r.record_id
  `.execute(db)
  await sql`
    ALTER TABLE records_reminders
      ALTER COLUMN org_id SET DEFAULT current_org_id(),
      ALTER COLUMN org_id SET NOT NULL
  `.execute(db)
  await sql`ALTER TABLE records_reminders ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON records_reminders FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON records_reminders`.execute(db)
  await sql`ALTER TABLE records_reminders DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE records_reminders DROP COLUMN org_id`.execute(db)
}
