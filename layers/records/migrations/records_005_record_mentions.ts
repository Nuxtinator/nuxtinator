import { type Kysely, sql } from 'kysely'

// Links from a record's rich text to other records (the "#" chips): one row
// per source field and target, so a record can list where it is mentioned.
// The field pipeline rewrites a field's rows on every write to it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('records_mentions')
    .addColumn('from_record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('field_key', 'text', col => col.notNull())
    .addColumn('to_record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('records_mentions_pkey', ['from_record_id', 'field_key', 'to_record_id'])
    .execute()
  await db.schema
    .createIndex('records_mentions_to_idx')
    .on('records_mentions')
    .column('to_record_id')
    .execute()

  // Rich text saved before this table existed. A chip is stored as
  // [@ id="<type>/<record id>" label="…" char="#"].
  await sql`
    INSERT INTO records_mentions (from_record_id, field_key, to_record_id)
    SELECT DISTINCT e.id, kv.key, t.id
    FROM records_entries e
    CROSS JOIN LATERAL jsonb_each(e.data) AS kv(key, value)
    CROSS JOIN LATERAL regexp_matches(
      kv.value #>> '{}',
      '\\[@\\s+[^]]*id="[^"/]+/([0-9a-fA-F-]{36})"[^]]*char="#"[^]]*]',
      'g'
    ) AS m(ids)
    JOIN records_entries t ON t.id::text = lower(m.ids[1])
    WHERE jsonb_typeof(kv.value) = 'string' AND t.id <> e.id
    ON CONFLICT DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('records_mentions').execute()
}
