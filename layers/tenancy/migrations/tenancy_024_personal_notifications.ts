import { type Kysely, sql } from 'kysely'

// Personal-app notifications. A personal app's transaction sets only
// `app.current_user`, so its rows get a null `org_id` (the `current_org_id()`
// default) and belong to no org. The recipient reads them with
// `app.current_user` set, which the bell does in every org; any personal-app
// transaction may notify any user. Background jobs have no user, so
// `personal_notification_recipients` (security definer) lists whose personal
// rows they need to visit.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE notifications ALTER COLUMN org_id DROP NOT NULL`.execute(db)

  await sql`
    CREATE POLICY personal_recipient ON notifications FOR ALL
      USING       (org_id IS NULL AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
      WITH CHECK  (org_id IS NULL AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
  `.execute(db)
  await sql`
    CREATE POLICY personal_insert ON notifications FOR INSERT
      WITH CHECK  (org_id IS NULL AND nullif(current_setting('app.current_user', true), '') IS NOT NULL)
  `.execute(db)

  // Recipients with personal rows: pending email of `p_mode` when it's set,
  // created before `p_before` when that's set.
  await sql`
    CREATE OR REPLACE FUNCTION personal_notification_recipients(p_mode text, p_before timestamptz)
    RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT DISTINCT user_id FROM notifications
      WHERE org_id IS NULL
        AND (p_mode IS NULL OR (email_mode = p_mode AND emailed_at IS NULL AND read_at IS NULL))
        AND (p_before IS NULL OR created_at < p_before)
    $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS personal_notification_recipients(text, timestamptz)`.execute(db)
  await sql`DROP POLICY IF EXISTS personal_insert ON notifications`.execute(db)
  await sql`DROP POLICY IF EXISTS personal_recipient ON notifications`.execute(db)
  await sql`DELETE FROM notifications WHERE org_id IS NULL`.execute(db)
  await sql`ALTER TABLE notifications ALTER COLUMN org_id SET NOT NULL`.execute(db)
}
