import { type Kysely, sql } from 'kysely'

// Where a column sits on the boards and lists grouped by a field: one row per
// column someone has placed, with a fractional-indexing key ("C" collation,
// so Postgres orders the keys by byte value like the client does). A row
// belongs to a stored view, or to the record whose built-in board it orders
// (the board of a card's tasks), and goes with it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('views_column_order')
    .addColumn('view_id', 'uuid', col => col.references('views_definitions.id').onDelete('cascade'))
    .addColumn('record_id', 'uuid', col => col.references('records_entries.id').onDelete('cascade'))
    .addColumn('field_key', 'text', col => col.notNull())
    .addColumn('column_key', 'text', col => col.notNull())
    .addColumn('position', sql`text collate "C"`, col => col.notNull())
    .addColumn('updated_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('views_column_order_owner', sql`(view_id is null) <> (record_id is null)`)
    .execute()
  await sql`
    create unique index views_column_order_view_uq on views_column_order (view_id, field_key, column_key)
      where view_id is not null
  `.execute(db)
  await sql`
    create unique index views_column_order_record_uq on views_column_order (record_id, field_key, column_key)
      where record_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('views_column_order').execute()
}
