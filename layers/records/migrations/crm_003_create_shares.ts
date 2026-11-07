import { type Kysely, sql } from 'kysely'

// Record-level visibility grants: a share row lets a specific user see one
// record they could not otherwise reach (users without view_all see only
// records they are assigned to or shared on).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('crm_record_shares')
    .addColumn('record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('granted_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('crm_record_shares_pk', ['record_id', 'user_id'])
    .execute()

  // "Records shared with this user" — the visibility predicate's entry point.
  await db.schema
    .createIndex('crm_record_shares_user_idx')
    .on('crm_record_shares')
    .column('user_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('crm_record_shares').execute()
}
