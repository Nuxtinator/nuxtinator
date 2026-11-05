import { type Kysely, sql } from 'kysely'

// Late tenancy migration (`_TL<NNN>_`): org_id + RLS for the record kernel's
// tables, plus the org-scoped uniques. On hosts that load the crm layer its
// crm_T001–T003 already did all of this under the tables' old names, so
// every step here checks first and skips what exists; on hosts that load
// records without crm, this is where the kernel tables become per-org.

async function hasColumn(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const res = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}
    ) AS present
  `.execute(db)
  return !!res.rows[0]?.present
}

async function hasIndex(db: Kysely<unknown>, name: string): Promise<boolean> {
  const res = await sql<{ present: boolean }>`select to_regclass(${name}) is not null as present`.execute(db)
  return !!res.rows[0]?.present
}

async function enableTenantScoping(db: Kysely<unknown>, table: string): Promise<void> {
  if (await hasColumn(db, table, 'org_id')) return
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

// FK-safe order: the records table before the tables that point at it.
const TABLES = [
  'records_entries',
  'records_field_entries',
  'records_user_refs',
  'records_connections',
  'records_shares',
  'records_activity',
  'records_comments',
  'records_types',
  'records_fields'
]

// Uniques whose columns carry no record FK (which would already be org-bound
// through the referenced row) lead with org_id in multi mode.
const RESCOPES = [
  { table: 'records_types', globalName: 'records_types_type_key_uniq', orgName: 'records_types_org_type_key_uniq', columns: sql`(org_id, type_key)`, where: sql`` },
  { table: 'records_fields', globalName: 'records_fields_type_field_uniq', orgName: 'records_fields_org_type_field_uniq', columns: sql`(org_id, type_key, field_key)`, where: sql`` },
  { table: 'records_entries', globalName: 'records_entries_type_user_uniq', orgName: 'records_entries_org_type_user_uniq', columns: sql`(org_id, record_type, user_id)`, where: sql`WHERE user_id IS NOT NULL` }
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await enableTenantScoping(db, table)
  }
  for (const { table, globalName, orgName, columns, where } of RESCOPES) {
    if (await hasIndex(db, orgName)) continue
    await sql`DROP INDEX IF EXISTS ${sql.ref(globalName)}`.execute(db)
    await sql`CREATE UNIQUE INDEX ${sql.ref(orgName)} ON ${sql.ref(table)} ${columns} ${where}`.execute(db)
  }
}

// Leaves the tenancy columns in place: on crm hosts they predate this
// migration, and dropping them would take the crm retrofits with them.
export async function down(): Promise<void> {}
