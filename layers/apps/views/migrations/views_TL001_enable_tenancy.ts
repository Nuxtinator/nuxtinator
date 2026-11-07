import { type Kysely, sql } from 'kysely'

// Tenancy for the views tables: `org_id` + RLS on each. A late tenancy
// migration so it runs after views_L001.

async function enableTenantScoping(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`
    ALTER TABLE ${sql.ref(table)}
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON ${sql.ref(table)} FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

async function disableTenantScoping(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.ref(table)}`.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} DROP COLUMN org_id`.execute(db)
}

// FK-safe order: views before the tables that point at them.
const TABLES = ['views_definitions', 'views_shares', 'views_teams', 'views_tabs', 'views_items', 'views_cards']

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await enableTenantScoping(db, table)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...TABLES].reverse()) {
    await disableTenantScoping(db, table)
  }
}
