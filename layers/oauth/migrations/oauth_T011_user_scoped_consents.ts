import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration. Only included by the migrator when the tenancy
// layer is loaded (filename contains `_T<NNN>_`).
//
// Makes `oauth_consents` and `oauth_pending_requests` user-scoped, like the
// token tables: a consent covers the permissions the user holds across every
// org, and tokens pick their org per call, so neither table has an org. Every
// query on them filters by `user_id`. The unique index on
// (client_id, user_id, resource) already allowed one consent per connection
// across orgs, so no rows need merging.

const TABLES = ['oauth_consents', 'oauth_pending_requests']

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.ref(table)}`.execute(db)
    await sql`ALTER TABLE ${sql.ref(table)} DISABLE ROW LEVEL SECURITY`.execute(db)
    await sql`ALTER TABLE ${sql.ref(table)} DROP COLUMN IF EXISTS org_id`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`
      ALTER TABLE ${sql.ref(table)}
        ADD COLUMN org_id uuid REFERENCES orgs(id) ON DELETE CASCADE
    `.execute(db)
  }
}
