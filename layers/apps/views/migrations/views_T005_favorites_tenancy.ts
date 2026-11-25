import { type Kysely, sql } from 'kysely'

// org_id + RLS for views_favorites.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE views_favorites
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`ALTER TABLE views_favorites ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON views_favorites FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON views_favorites`.execute(db)
  await sql`ALTER TABLE views_favorites DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE views_favorites DROP COLUMN org_id`.execute(db)
}
