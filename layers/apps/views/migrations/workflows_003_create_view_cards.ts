import { type Kysely, sql } from 'kysely'

// Per-view card state. Two uses share this table:
//
// - Custom-column boards: one row per record on the board — `column_key` is
//   the custom column the card sits in (exactly one row per record, enforced
//   by the placement transaction, not the schema).
// - Field-grouped boards: a row exists only once a card has been manually
//   ranked — `column_key` is the grouping field's option key ('' = the
//   "No value" column). Rows whose column no longer matches the record's
//   current field value are ignored by the renderer and swept on later drags.
//
// `rank` is a fractional index (lexicographic text ordering); null means the
// card has no manual position and sorts by the view's field sort.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('workflows_view_cards')
    .addColumn('view_id', 'uuid', col => col.notNull().references('workflows_views.id').onDelete('cascade'))
    .addColumn('record_id', 'uuid', col => col.notNull().references('crm_records.id').onDelete('cascade'))
    .addColumn('column_key', 'text', col => col.notNull().defaultTo(''))
    .addColumn('rank', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('workflows_view_cards_pk', ['view_id', 'record_id', 'column_key'])
    .execute()

  // Board load path: all placements for a view, ordered within columns.
  await db.schema
    .createIndex('workflows_view_cards_view_column_idx')
    .on('workflows_view_cards')
    .columns(['view_id', 'column_key'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('workflows_view_cards').execute()
}
