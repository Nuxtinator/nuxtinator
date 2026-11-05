import { type Kysely, sql } from 'kysely'

// The record kernel's tables were created as crm_* (crm_001–crm_012) while
// the kernel lived in the crm layer; they now belong to the records layer
// and take its prefix. A late migration (`_L<NNN>_`, see core's
// migration-names.ts) so it runs after every tenancy retrofit committed
// against the old names (crm_T001–T003).
//
// ALTER ... RENAME only rewrites catalog entries: rows, RLS policies,
// foreign keys (including the crm and inbox tables pointing at these) and
// grants follow the table. Index and constraint names are renamed too, for
// consistency; IF EXISTS covers the variants that differ between single and
// multi mode (org-scoped uniques exist only after the tenancy retrofit).

const TABLES: Array<[string, string]> = [
  ['crm_records', 'records_entries'],
  ['crm_record_field_entries', 'records_field_entries'],
  ['crm_record_user_refs', 'records_user_refs'],
  ['crm_record_connections', 'records_connections'],
  ['crm_record_shares', 'records_shares'],
  ['crm_record_activity', 'records_activity'],
  ['crm_record_comments', 'records_comments'],
  ['crm_record_types', 'records_types'],
  ['crm_record_fields', 'records_fields']
]

const INDEXES: Array<[string, string]> = [
  ['crm_records_type_idx', 'records_entries_type_idx'],
  ['crm_records_type_status_idx', 'records_entries_type_status_idx'],
  ['crm_records_type_updated_idx', 'records_entries_type_updated_idx'],
  ['crm_records_data_gin_idx', 'records_entries_data_gin_idx'],
  ['crm_records_type_name_idx', 'records_entries_type_name_idx'],
  ['crm_records_type_user_uniq', 'records_entries_type_user_uniq'],
  ['crm_records_org_type_user_uniq', 'records_entries_org_type_user_uniq'],
  ['crm_records_user_idx', 'records_entries_user_idx'],
  ['crm_record_field_entries_record_field_value_uniq', 'records_field_entries_record_field_value_uniq'],
  ['crm_record_field_entries_field_value_idx', 'records_field_entries_field_value_idx'],
  ['crm_record_user_refs_user_field_idx', 'records_user_refs_user_field_idx'],
  ['crm_record_connections_from_field_to_uniq', 'records_connections_from_field_to_uniq'],
  ['crm_record_connections_to_idx', 'records_connections_to_idx'],
  ['crm_record_shares_user_idx', 'records_shares_user_idx'],
  ['crm_record_activity_record_created_idx', 'records_activity_record_created_idx'],
  ['crm_record_types_type_key_uniq', 'records_types_type_key_uniq'],
  ['crm_record_types_org_type_key_uniq', 'records_types_org_type_key_uniq'],
  ['crm_record_fields_type_field_uniq', 'records_fields_type_field_uniq'],
  ['crm_record_fields_org_type_field_uniq', 'records_fields_org_type_field_uniq']
]

// Primary-key constraints whose names were chosen explicitly; the implicit
// <table>_pkey names keep their old form, which nothing references.
const CONSTRAINTS: Array<[string, string, string]> = [
  ['records_user_refs', 'crm_record_user_refs_pk', 'records_user_refs_pk'],
  ['records_shares', 'crm_record_shares_pk', 'records_shares_pk']
]

async function renameConstraint(db: Kysely<unknown>, table: string, from: string, to: string): Promise<void> {
  const found = await sql<{ present: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${from}) AS present
  `.execute(db)
  if (!found.rows[0]?.present) return
  await sql`ALTER TABLE ${sql.ref(table)} RENAME CONSTRAINT ${sql.ref(from)} TO ${sql.ref(to)}`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [from, to] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(from)} RENAME TO ${sql.ref(to)}`.execute(db)
  }
  for (const [from, to] of INDEXES) {
    await sql`ALTER INDEX IF EXISTS ${sql.ref(from)} RENAME TO ${sql.ref(to)}`.execute(db)
  }
  for (const [table, from, to] of CONSTRAINTS) {
    await renameConstraint(db, table, from, to)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [table, from, to] of CONSTRAINTS) {
    await renameConstraint(db, table, to, from)
  }
  for (const [from, to] of INDEXES) {
    await sql`ALTER INDEX IF EXISTS ${sql.ref(to)} RENAME TO ${sql.ref(from)}`.execute(db)
  }
  for (const [from, to] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(to)} RENAME TO ${sql.ref(from)}`.execute(db)
  }
}
