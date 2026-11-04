import { type Kysely, sql } from 'kysely'

// Who an invite comes from: 'admin' (a host or org admin; may grant orgs and
// personal apps) or 'share' (a user sharing a personal item; grants only the
// shares that point at it). Every invite before this column was an admin's.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE invites
      ADD COLUMN kind text NOT NULL DEFAULT 'admin' CHECK (kind IN ('admin', 'share'))
  `.execute(db)
  await sql`CREATE INDEX invites_share_inviter_idx ON invites (invited_by) WHERE kind = 'share'`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE invites DROP COLUMN kind`.execute(db)
}
