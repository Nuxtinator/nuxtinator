import { type Kysely, sql } from 'kysely'

// A record can be linked to the user account of the person it describes
// (e.g. a contact who also signs in to the host app). The link carries no
// permissions: it marks the record's name and email addresses as owned by
// that account (see utils/account-link.ts). One record per type per user;
// crm_T003 rescopes the unique to the org in multi mode. The plain user_id
// index serves the ON DELETE SET NULL when a user is deleted.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('crm_records')
    .addColumn('user_id', 'uuid', col => col.references('users.id').onDelete('set null'))
    .execute()
  await sql`
    CREATE UNIQUE INDEX crm_records_type_user_uniq
      ON crm_records (record_type, user_id) WHERE user_id IS NOT NULL
  `.execute(db)
  await sql`CREATE INDEX crm_records_user_idx ON crm_records (user_id) WHERE user_id IS NOT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('crm_records').dropColumn('user_id').execute()
}
