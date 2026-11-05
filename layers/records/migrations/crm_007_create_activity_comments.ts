import { type Kysely, sql } from 'kysely'

// Per-record display timeline. crm_record_activity is the change log shown
// on a record (full old/new values, no truncation) — distinct from
// crm_consent_events, which is channel-keyed compliance proof and survives
// record deletion; these rows cascade with their record. crm_record_comments
// is the human discussion thread on a record.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('crm_record_activity')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    .addColumn('actor_user_id', 'uuid', col => col.references('users.id').onDelete('set null'))
    // Display name for system/magic-link actors; when set it wins over
    // resolving actor_user_id to a user name.
    .addColumn('actor_label', 'text')
    .addColumn('action', 'text', col => col.notNull())
    .addColumn('field_key', 'text')
    .addColumn('old_value', 'jsonb')
    .addColumn('new_value', 'jsonb')
    // Write-time human-readable message for events not tied to a field
    // (e.g. "Imported from CSV batch #12").
    .addColumn('note', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await sql`
    CREATE INDEX crm_record_activity_record_created_idx
      ON crm_record_activity (record_id, created_at DESC)
  `.execute(db)

  await db.schema
    .createTable('crm_record_comments')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    // Nullable: system/magic-link comments have no user row.
    .addColumn('author_id', 'uuid', col => col.references('users.id').onDelete('set null'))
    // Display name when author_id is null, e.g. "Jane Doe (via magic link)".
    .addColumn('author_label', 'text')
    .addColumn('body', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('edited_at', 'timestamptz')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('crm_record_comments').execute()
  await db.schema.dropTable('crm_record_activity').execute()
}
