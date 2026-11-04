import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration. Only included by the migrator when the tenancy
// layer is loaded. List of 100 is a personal app (see list-of-100_002), so its
// contacts stop belonging to an org: each user's lists from every org merge
// into one. Members of orgs that had the app on keep it through a `user_apps`
// grant.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO user_apps (user_id, app_id)
    SELECT DISTINCT m.user_id, 'list-of-100'
      FROM memberships m
      JOIN org_apps oa ON oa.org_id = m.org_id AND oa.app_id = 'list-of-100' AND oa.enabled
    ON CONFLICT (user_id, app_id) DO NOTHING
  `.execute(db)
  await sql`DROP POLICY IF EXISTS tenant_isolation ON list_of_100_contacts`.execute(db)
  await sql`ALTER TABLE list_of_100_contacts DROP COLUMN org_id`.execute(db)
  await sql`DELETE FROM org_apps WHERE app_id = 'list-of-100'`.execute(db)
}

// Every contact goes back to the org named by the session's `app.current_org`
// (or fails without one), so this only suits a database with no contacts yet.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE list_of_100_contacts
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON list_of_100_contacts FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}
