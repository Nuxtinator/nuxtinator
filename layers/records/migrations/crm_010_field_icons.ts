import type { Kysely } from 'kysely'

// Field icons follow the record-type pattern: manifests declare the code
// default (CrmFieldDef.icon), this column stores only an explicit admin
// override (or the chosen icon of an admin-created custom field). NULL means
// "no override" — the merged reader falls back to the manifest.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('crm_record_fields')
    .addColumn('icon_override', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('crm_record_fields')
    .dropColumn('icon_override')
    .execute()
}
