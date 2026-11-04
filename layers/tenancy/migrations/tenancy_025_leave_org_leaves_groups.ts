import { type Kysely, sql } from 'kysely'

// Leaving an org takes the person out of its groups in the same statement,
// whichever path deletes the membership.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION memberships_leave_org_groups() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      DELETE FROM group_members gm
        USING groups g
        WHERE gm.group_id = g.id AND g.org_id = OLD.org_id AND gm.user_id = OLD.user_id;
      RETURN OLD;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER memberships_leave_org_groups
      AFTER DELETE ON memberships
      FOR EACH ROW EXECUTE FUNCTION memberships_leave_org_groups()
  `.execute(db)
  // Rows left behind by memberships removed before this trigger existed.
  await sql`
    DELETE FROM group_members gm
      USING groups g
      WHERE gm.group_id = g.id AND g.org_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = g.org_id AND m.user_id = gm.user_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS memberships_leave_org_groups ON memberships`.execute(db)
  await sql`DROP FUNCTION IF EXISTS memberships_leave_org_groups()`.execute(db)
}
