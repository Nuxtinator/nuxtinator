import { type Kysely, sql } from 'kysely'

// An org without an `org_apps` row gets an app only when its catalog status
// is 'default'. Orgs that were already using an 'available' app without a row
// keep it via an explicit enabled row.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO org_apps (org_id, app_id, enabled, source)
    SELECT o.id, a.id, true, 'auto'
    FROM orgs o
    CROSS JOIN apps a
    WHERE a.status = 'available'
    ON CONFLICT (org_id, app_id) DO NOTHING
  `.execute(db)
}

export async function down(): Promise<void> {}
