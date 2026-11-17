import { type Kysely, sql } from 'kysely'

// The kernel's suppression rule as SQL, for set-based queries:
// `WHERE NOT mail_is_suppressed(email, org_id)`. Must agree with the
// kernel's addressHash() and notSuppressed().
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION mail_is_suppressed(addr text, org uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM mail_suppressions s
        WHERE s.cleared_at IS NULL
          AND s.address_hash = encode(sha256(convert_to(lower(btrim(addr)), 'UTF8')), 'hex')
          AND (s.scope = 'global'
            OR (s.scope = 'org'  AND s.org_id = org)
            OR (s.scope = 'host' AND org IS NULL))
      )
    $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION mail_is_suppressed(text, uuid)`.execute(db)
}
