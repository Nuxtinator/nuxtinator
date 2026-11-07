import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration. Only included by the migrator when the tenancy
// layer is loaded (filename contains `_T<NNN>_`). Adds `org_id` + RLS to
// every crm table so multi-tenant deploys isolate one org's CRM data from
// another's.
//
// All crm content is per-org: records and their field storage, shares,
// channels (a channel identity is an org-level asset, not a global one),
// consent state and events, suppressions, activity, comments, and the
// schema-builder definition tables.

// The record kernel's tables (crm_records, crm_record_*) carry records_*
// names once the records layer's records_001 has renamed them, which on a
// fresh install happens before this runs. Maps a kernel table or index name
// to the one in place.
async function kernelNames(db: Kysely<unknown>): Promise<(name: string) => string> {
  const res = await sql<{ renamed: boolean }>`select to_regclass('records_entries') is not null as renamed`.execute(db)
  if (!res.rows[0]?.renamed) return name => name
  return (name) => {
    if (name.startsWith('crm_records')) return `records_entries${name.slice('crm_records'.length)}`
    if (name.startsWith('crm_record_')) return `records_${name.slice('crm_record_'.length)}`
    return name
  }
}

async function enableTenantScoping(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`
    ALTER TABLE ${sql.ref(table)}
      ADD COLUMN org_id uuid NOT NULL DEFAULT current_org_id()
        REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY tenant_isolation ON ${sql.ref(table)} FOR ALL
      USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
      WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  `.execute(db)
}

async function disableTenantScoping(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.ref(table)}`.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} DISABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE ${sql.ref(table)} DROP COLUMN org_id`.execute(db)
}

// FK-safe order: referenced tables (records, channel_types, channels) before
// the tables that point at them.
const TABLES = [
  'crm_records',
  'crm_record_field_entries',
  'crm_record_user_refs',
  'crm_record_connections',
  'crm_record_shares',
  'crm_channel_types',
  'crm_channels',
  'crm_contact_channels',
  'crm_channel_consents',
  'crm_consent_events',
  'crm_channel_suppressions',
  'crm_record_activity',
  'crm_record_comments',
  'crm_record_types',
  'crm_record_fields'
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  const name = await kernelNames(db)
  for (const t of TABLES) {
    await enableTenantScoping(db, name(t))
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const name = await kernelNames(db)
  for (const t of [...TABLES].reverse()) {
    await disableTenantScoping(db, name(t))
  }
}
