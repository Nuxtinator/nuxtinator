import { type Kysely, sql } from 'kysely'

// Files on attachments fields. Each row is one uploaded file on one record's
// field; the bytes live in object storage under `storage_key`. Deleting a row
// (directly, or with its record) queues its object in
// records_attachment_trash, which a background sweep empties.
//
// Another layer may keep files for its own per-record fields here too, under
// a field key namespaced by that layer (`views:<viewId>:<fieldKey>`).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('records_attachments')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('field_key', 'text', col => col.notNull())
    .addColumn('storage_key', 'text', col => col.notNull())
    .addColumn('filename', 'text', col => col.notNull())
    .addColumn('mime', 'text', col => col.notNull())
    .addColumn('size_bytes', 'bigint', col => col.notNull())
    .addColumn('sort_order', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('created_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createIndex('records_attachments_record_field_idx')
    .on('records_attachments')
    .columns(['record_id', 'field_key', 'sort_order'])
    .execute()

  // Storage keys only (random object names): no org data, so no org scoping.
  await db.schema
    .createTable('records_attachment_trash')
    .addColumn('storage_key', 'text', col => col.primaryKey())
    .addColumn('deleted_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await sql`
    CREATE FUNCTION records_attachment_trash_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO records_attachment_trash (storage_key) VALUES (OLD.storage_key)
        ON CONFLICT DO NOTHING;
      RETURN OLD;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER records_attachments_trash AFTER DELETE ON records_attachments
      FOR EACH ROW EXECUTE FUNCTION records_attachment_trash_fn()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS records_attachments_trash ON records_attachments`.execute(db)
  await sql`DROP FUNCTION IF EXISTS records_attachment_trash_fn()`.execute(db)
  await db.schema.dropTable('records_attachment_trash').execute()
  await db.schema.dropTable('records_attachments').execute()
}
