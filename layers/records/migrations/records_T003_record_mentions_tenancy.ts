import { type Kysely, sql } from 'kysely'

// org_id + RLS for records_mentions. Rows the table already holds take the
// org of the record they link from.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE records_mentions
      ADD COLUMN org_id uuid REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`
    UPDATE records_mentions m SET org_id = e.org_id
    FROM records_entries e WHERE e.id = m.from_record_id
  `.execute(db)
  await sql`
    ALTER TABLE records_mentions
      ALTER COLUMN org_id SET DEFAULT current_org_id(),
      ALTER COLUMN org_id SET NOT NULL
  `.execute(db)
  await sql`ALTER TABLE records_mentions ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON records_mentions FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON records_mentions`.execute(db)
  await sql`ALTER TABLE records_mentions DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE records_mentions DROP COLUMN org_id`.execute(db)
}
