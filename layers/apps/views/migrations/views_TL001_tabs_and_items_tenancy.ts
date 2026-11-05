import { type Kysely, sql } from 'kysely'

// Tenancy for the tables views_L003 adds. A late tenancy migration
// (`_TL<NNN>_`): runs only with the tenancy layer, after views_L003. Rows that
// L003 created take their view's org before the column turns NOT NULL;
// new rows default to the current org like every other tenant table.

const TABLES = ['views_tabs', 'views_items']

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`
      ALTER TABLE ${sql.ref(table)}
        ADD COLUMN org_id uuid REFERENCES orgs(id) ON DELETE CASCADE
    `.execute(db)
    await sql`
      UPDATE ${sql.ref(table)} t SET org_id = v.org_id
      FROM views_definitions v WHERE v.id = t.view_id
    `.execute(db)
    await sql`
      ALTER TABLE ${sql.ref(table)}
        ALTER COLUMN org_id SET NOT NULL,
        ALTER COLUMN org_id SET DEFAULT current_org_id()
    `.execute(db)
    await sql`ALTER TABLE ${sql.ref(table)} ENABLE ROW LEVEL SECURITY`.execute(db)
    await sql`
      CREATE POLICY tenant_isolation ON ${sql.ref(table)} FOR ALL
        USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
        WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...TABLES].reverse()) {
    await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.ref(table)}`.execute(db)
    await sql`ALTER TABLE ${sql.ref(table)} DISABLE ROW LEVEL SECURITY`.execute(db)
    await sql`ALTER TABLE ${sql.ref(table)} DROP COLUMN org_id`.execute(db)
  }
}
