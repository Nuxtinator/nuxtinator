import { type Kysely, sql } from 'kysely'

// Non-jsonb field storage classes. Multi-value fields whose entries need
// per-value uniqueness or lookup live in crm_record_field_entries;
// user_select fields in crm_record_user_refs; connection fields in
// crm_record_connections. Which class a field uses is decided by the
// manifest-driven storage router, never by callers directly.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('crm_record_field_entries')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    .addColumn('field_key', 'text', col => col.notNull())
    .addColumn('payload', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    // Canonical comparable form of the entry value; null when the entry has
    // no meaningful identity (dedupe/uniqueness then does not apply).
    .addColumn('normalized_value', 'text')
    .addColumn('sort_order', 'integer', col => col.notNull().defaultTo(0))
    .execute()

  await sql`
    CREATE UNIQUE INDEX crm_record_field_entries_record_field_value_uniq
      ON crm_record_field_entries (record_id, field_key, normalized_value)
      WHERE normalized_value IS NOT NULL
  `.execute(db)

  // Reverse lookup: which records hold a given value for a given field.
  await db.schema
    .createIndex('crm_record_field_entries_field_value_idx')
    .on('crm_record_field_entries')
    .columns(['field_key', 'normalized_value'])
    .execute()

  await db.schema
    .createTable('crm_record_user_refs')
    .addColumn('record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    .addColumn('field_key', 'text', col => col.notNull())
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('crm_record_user_refs_pk', ['record_id', 'field_key', 'user_id'])
    .execute()

  // "Records referencing this user" — assignment lists and visibility checks.
  await db.schema
    .createIndex('crm_record_user_refs_user_field_idx')
    .on('crm_record_user_refs')
    .columns(['user_id', 'field_key'])
    .execute()

  await db.schema
    .createTable('crm_record_connections')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('from_record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    .addColumn('to_record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    .addColumn('field_key', 'text', col => col.notNull())
    .addColumn('meta', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute()

  await db.schema
    .createIndex('crm_record_connections_from_field_to_uniq')
    .on('crm_record_connections')
    .columns(['from_record_id', 'field_key', 'to_record_id'])
    .unique()
    .execute()

  // Reverse traversal: connections pointing at a record.
  await db.schema
    .createIndex('crm_record_connections_to_idx')
    .on('crm_record_connections')
    .column('to_record_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('crm_record_connections').execute()
  await db.schema.dropTable('crm_record_user_refs').execute()
  await db.schema.dropTable('crm_record_field_entries').execute()
}
