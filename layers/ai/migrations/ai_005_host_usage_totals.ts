import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// The operator spend function under a name of its own, so its columns can
// differ from `ai_usage_host_daily`, which ai_T004 recreates with its original
// columns on tenancy installs (regular migrations all run before tenancy
// ones). Same rows as ai_004's version: `ai_usage` summed per day, user,
// feature, subject, model and key source, from `p_from` on; ai_T006 adds the
// org column when tenancy is loaded. Also drops ai_004's subject index, which
// no query filters by.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION ai_usage_host_daily_totals(p_from timestamptz DEFAULT NULL)
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
  await sql`DROP FUNCTION IF EXISTS ai_usage_host_daily(timestamptz)`.execute(db)
  await sql`DROP INDEX IF EXISTS ai_usage_subject_created_at_idx`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX ai_usage_subject_created_at_idx ON ai_usage (subject, created_at) WHERE subject IS NOT NULL`.execute(db)
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
  await sql`DROP FUNCTION IF EXISTS ai_usage_host_daily_totals(timestamptz)`.execute(db)
}
