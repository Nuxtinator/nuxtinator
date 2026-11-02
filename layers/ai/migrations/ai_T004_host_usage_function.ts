import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration, included only when the tenancy layer is loaded.
// Adds `org_id` to ai_003's operator spend function; personal-app calls come
// back with a null org.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION ai_usage_host_daily(p_from timestamptz DEFAULT NULL)
    RETURNS TABLE (day timestamptz, org_id uuid, user_id uuid, feature text, model text, key_source text,
                   cost numeric, calls bigint, unpriced bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT date_trunc('day', created_at), org_id, user_id, feature, model, key_source,
             sum(cost), count(*), count(*) FILTER (WHERE cost IS NULL)
      FROM ai_usage
      WHERE p_from IS NULL OR created_at >= p_from
      GROUP BY 1, 2, 3, 4, 5, 6
    $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
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
