import { type Kysely, sql } from 'kysely'

// Values of a view's own fields (declared in its definition's `fields`), one
// row per view, record and field. Everyone who can open the view sees the
// same values. Single-value kinds store a jsonb scalar, the rest a jsonb
// array. Files on a view's attachments fields live in records_attachments,
// not here.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('views_values')
    .addColumn('view_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('field_key', 'text', col => col.notNull())
    .addColumn('value', 'jsonb', col => col.notNull())
    .addColumn('updated_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_values_pk', ['view_id', 'record_id', 'field_key'])
    .execute()
  await db.schema.createIndex('views_values_record_idx').on('views_values').column('record_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('views_values').execute()
}
