import { type Kysely, sql } from 'kysely'

// Converts placeholder invite users (no password, not verified) into `invites`
// rows. Each invite reuses the placeholder's id, and the token hash is computed
// from the existing `token_key`, so links already in people's inboxes keep
// working. When the tenancy layer's `memberships` table exists, the
// placeholders are left for `tenancy_022` to delete after it copies their
// memberships into `invite_orgs`; otherwise they are deleted here.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO invites (id, token_hash, email, display_name, created_at, expires_at)
    SELECT id,
           encode(digest(token_key, 'sha256'), 'hex'),
           lower(email),
           display_name,
           created,
           coalesce(token_expires_at, now())
      FROM users
     WHERE password IS NULL AND verified = false
  `.execute(db)

  const memberships = await sql<{ t: string | null }>`SELECT to_regclass('public.memberships')::text AS t`.execute(db)
  if (!memberships.rows[0]?.t) {
    await sql`DELETE FROM users WHERE id IN (SELECT id FROM invites)`.execute(db)
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
