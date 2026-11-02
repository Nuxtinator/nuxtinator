import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// The operator's spend view: `ai_usage` summed per day, org, user, feature,
// model and key source, from `p_from` on (everything when null). SECURITY
// DEFINER so it reads every org's rows past RLS; it returns totals, never a
// call's row. This is the single-tenant shape (no `org_id`); ai_T004 replaces
// it when the tenancy layer is loaded.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION ai_usage_host_daily(p_from timestamptz DEFAULT NULL)
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS ai_usage_host_daily(timestamptz)`.execute(db)
}
