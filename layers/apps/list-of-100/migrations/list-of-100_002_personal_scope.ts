import { type Kysely, sql } from 'kysely'

// List of 100 is a personal app: each user's list is theirs in every org.
// Rows are keyed on the `app.current_user` setting the personal-app handlers
// set (core's personal-apps.ts); in multi-tenant mode
// `list-of-100_T002_drop_tenancy` removes the org scoping T001 added.
//
// Users who already have contacts keep access through a `user_apps` grant.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE list_of_100_contacts ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY user_isolation ON list_of_100_contacts FOR ALL
      USING       (user_id = nullif(current_setting('app.current_user', true), '')::uuid)
      WITH CHECK  (user_id = nullif(current_setting('app.current_user', true), '')::uuid)
  `.execute(db)

  await sql`INSERT INTO apps (id) VALUES ('list-of-100') ON CONFLICT (id) DO NOTHING`.execute(db)
  await sql`
    INSERT INTO user_apps (user_id, app_id)
    SELECT DISTINCT user_id, 'list-of-100' FROM list_of_100_contacts
    ON CONFLICT (user_id, app_id) DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS user_isolation ON list_of_100_contacts`.execute(db)
  await sql`ALTER TABLE list_of_100_contacts DISABLE ROW LEVEL SECURITY`.execute(db)
}
