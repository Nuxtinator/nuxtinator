import { type Kysely, sql } from 'kysely'

// A built-in board's own choices for the record it stands for (the board of
// a card's tasks): its sort, which everyone who opens that board sees,
// stored only once someone picks one. `tab_id` is the built-in tab's stable
// id, the same for every record, so it has no FK; the row goes with its record.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('views_record_tabs')
    .addColumn('record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('tab_id', 'uuid', col => col.notNull())
    .addColumn('definition', 'jsonb', col => col.notNull())
    .addColumn('updated_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_record_tabs_pk', ['record_id', 'tab_id'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('views_record_tabs').execute()
}
