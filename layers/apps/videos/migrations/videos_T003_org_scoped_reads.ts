import { type Kysely, sql } from 'kysely'

// Drops the read policy that also exposed every org's public videos, leaving
// `videos_tenant_write` (FOR ALL, active org only) as the table's sole policy.
// Public share routes reach a video through `withRecordOrgContext`, which sets
// the GUC to the video's own org.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS videos_tenant_read ON videos`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE POLICY videos_tenant_read ON videos FOR SELECT
      USING (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR visibility = 'public'
      )
  `.execute(db)
}
