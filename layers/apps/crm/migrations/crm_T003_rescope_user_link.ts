import { type Kysely, sql } from 'kysely'

// Multi mode: the same person can have a linked record in every org, so the
// one-record-per-type-per-user unique from crm_011 leads with org_id (the
// same rescoping crm_T002 does for the other uniques).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('crm_records_type_user_uniq').execute()
  await sql`
    CREATE UNIQUE INDEX crm_records_org_type_user_uniq
      ON crm_records (org_id, record_type, user_id) WHERE user_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('crm_records_org_type_user_uniq').execute()
  await sql`
    CREATE UNIQUE INDEX crm_records_type_user_uniq
      ON crm_records (record_type, user_id) WHERE user_id IS NOT NULL
  `.execute(db)
}
