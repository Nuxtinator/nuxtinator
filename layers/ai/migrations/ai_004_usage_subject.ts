import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// What inside a feature each AI call ran for, as `<prefix>:<id>` (a bot, an
// inbox); null when the caller didn't say. The operator spend function groups
// by it too; ai_T005 gives that function its org column when the tenancy
// layer is loaded. Adding a column changes the function's return type, so it
// is dropped and recreated rather than replaced.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ai_usage ADD COLUMN subject text`.execute(db)
  await sql`CREATE INDEX ai_usage_subject_created_at_idx ON ai_usage (subject, created_at) WHERE subject IS NOT NULL`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ai_usage_host_daily(timestamptz)`.execute(db)
  await sql`
    CREATE FUNCTION ai_usage_host_daily(p_from timestamptz DEFAULT NULL)
    RETURNS TABLE (day timestamptz, org_id uuid, user_id uuid, feature text, subject text, model text, key_source text,
                   cost numeric, calls bigint, unpriced bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT date_trunc('day', created_at), NULL::uuid, user_id, feature, subject, model, key_source,
             sum(cost), count(*), count(*) FILTER (WHERE cost IS NULL)
      FROM ai_usage
      WHERE p_from IS NULL OR created_at >= p_from
      GROUP BY 1, 3, 4, 5, 6, 7
    $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS ai_usage_host_daily(timestamptz)`.execute(db)
  await sql`
    CREATE FUNCTION ai_usage_host_daily(p_from timestamptz DEFAULT NULL)
    RETURNS TABLE (day timestamptz, org_id uuid, user_id uuid, feature text, model text, key_source text,
                   cost numeric, calls bigint, unpriced bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT date_trunc('day', created_at), NULL::uuid, user_id, feature, model, key_source,
             sum(cost), count(*), count(*) FILTER (WHERE cost IS NULL)
      FROM ai_usage
      WHERE p_from IS NULL OR created_at >= p_from
      GROUP BY 1, 3, 4, 5, 6
    $$
  `.execute(db)
  await sql`DROP INDEX IF EXISTS ai_usage_subject_created_at_idx`.execute(db)
  await sql`ALTER TABLE ai_usage DROP COLUMN subject`.execute(db)
}
