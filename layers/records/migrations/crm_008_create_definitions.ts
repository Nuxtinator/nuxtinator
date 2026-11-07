import { type Kysely, sql } from 'kysely'

// Schema-builder storage, following the code-owned-defaults pattern: code
// manifests declare types/fields with their defaults; these tables hold only
// explicit customizations. A row is either an override of a code-declared
// type/field (only the *_override columns that were changed are set) or an
// admin-created custom one (crm_record_types.is_custom, or a
// crm_record_fields row with `kind` set). Readers merge code manifests over
// these rows, treating orphan rows as the custom entries.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('crm_record_types')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('type_key', 'text', col => col.notNull())
    .addColumn('label_override', 'text')
    .addColumn('label_singular_override', 'text')
    .addColumn('icon_override', 'text')
    .addColumn('hidden', 'boolean', col => col.notNull().defaultTo(false))
    // Type-level presentation settings, e.g. section order.
    .addColumn('config', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('is_custom', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('updated_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('crm_record_types_type_key_uniq')
    .on('crm_record_types')
    .column('type_key')
    .unique()
    .execute()

  await db.schema
    .createTable('crm_record_fields')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('type_key', 'text', col => col.notNull())
    .addColumn('field_key', 'text', col => col.notNull())
    // Set only on admin-created custom fields; null means the row overrides
    // a manifest-declared field whose kind is code-owned.
    .addColumn('kind', 'text')
    .addColumn('label_override', 'text')
    .addColumn('hidden', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('required_override', 'boolean')
    .addColumn('order_override', 'integer')
    .addColumn('section_override', 'text')
    // Per-option overrides and admin-added custom options (user content, so
    // DB storage is the right home).
    .addColumn('config', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('updated_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('crm_record_fields_type_field_uniq')
    .on('crm_record_fields')
    .columns(['type_key', 'field_key'])
    .unique()
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('crm_record_fields').execute()
  await db.schema.dropTable('crm_record_types').execute()
}
