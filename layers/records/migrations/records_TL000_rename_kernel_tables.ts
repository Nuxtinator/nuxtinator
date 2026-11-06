import { type Kysely, sql } from 'kysely'

// Renames the record kernel's tables forward again after crm_T000 put the
// crm_* names back for crm_T001–T003, along with the org-scoped uniques those
// migrations created under the old names. Sorts before records_TL001 and does
// nothing when the tables already carry the records_* names.

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
  ['crm_records_type_user_uniq', 'records_entries_type_user_uniq'],
  ['crm_records_org_type_user_uniq', 'records_entries_org_type_user_uniq'],
  ['crm_record_types_type_key_uniq', 'records_types_type_key_uniq'],
  ['crm_record_types_org_type_key_uniq', 'records_types_org_type_key_uniq'],
  ['crm_record_fields_type_field_uniq', 'records_fields_type_field_uniq'],
  ['crm_record_fields_org_type_field_uniq', 'records_fields_org_type_field_uniq']
]

export async function up(db: Kysely<unknown>): Promise<void> {
  const res = await sql<{ restored: boolean }>`
    select to_regclass('crm_records') is not null and to_regclass('records_entries') is null as restored
  `.execute(db)
  if (!res.rows[0]?.restored) return
  for (const [oldName, newName] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(oldName)} RENAME TO ${sql.ref(newName)}`.execute(db)
  }
  for (const [oldName, newName] of INDEXES) {
    await sql`ALTER INDEX IF EXISTS ${sql.ref(oldName)} RENAME TO ${sql.ref(newName)}`.execute(db)
  }
}

export async function down(): Promise<void> {}
