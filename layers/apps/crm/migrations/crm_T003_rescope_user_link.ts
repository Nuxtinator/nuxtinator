import { type Kysely, sql } from 'kysely'

// Multi mode: the same person can have a linked record in every org, so the
// one-record-per-type-per-user unique from crm_011 leads with org_id (the
// same rescoping crm_T002 does for the other uniques).

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

export async function up(db: Kysely<unknown>): Promise<void> {
  const name = await kernelNames(db)
  await db.schema.dropIndex(name('crm_records_type_user_uniq')).execute()
  await sql`
    CREATE UNIQUE INDEX ${sql.ref(name('crm_records_org_type_user_uniq'))}
      ON ${sql.ref(name('crm_records'))} (org_id, record_type, user_id) WHERE user_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const name = await kernelNames(db)
  await db.schema.dropIndex(name('crm_records_org_type_user_uniq')).execute()
  await sql`
    CREATE UNIQUE INDEX ${sql.ref(name('crm_records_type_user_uniq'))}
      ON ${sql.ref(name('crm_records'))} (record_type, user_id) WHERE user_id IS NOT NULL
  `.execute(db)
}
