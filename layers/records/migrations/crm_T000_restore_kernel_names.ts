import { type Kysely, sql } from 'kysely'

// crm_T001–T003 were written against the record kernel's crm_* names. On a
// database where records_L001 renamed those tables before the tenancy layer
// was loaded, this puts the old table and index names back so those
// migrations run; records_TL000 renames them forward again afterwards. Sorts
// before crm_T001 and does nothing while the old names are in place.

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

// The global uniques crm_T002/T003 drop by name.
const INDEXES: Array<[string, string]> = [
  ['crm_records_type_user_uniq', 'records_entries_type_user_uniq'],
  ['crm_record_types_type_key_uniq', 'records_types_type_key_uniq'],
  ['crm_record_fields_type_field_uniq', 'records_fields_type_field_uniq']
]

export async function up(db: Kysely<unknown>): Promise<void> {
  const res = await sql<{ renamed: boolean }>`
    select to_regclass('crm_records') is null and to_regclass('records_entries') is not null as renamed
  `.execute(db)
  if (!res.rows[0]?.renamed) return
  for (const [oldName, newName] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(newName)} RENAME TO ${sql.ref(oldName)}`.execute(db)
  }
  for (const [oldName, newName] of INDEXES) {
    await sql`ALTER INDEX IF EXISTS ${sql.ref(newName)} RENAME TO ${sql.ref(oldName)}`.execute(db)
  }
}

export async function down(): Promise<void> {}
