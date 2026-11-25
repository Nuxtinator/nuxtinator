import { type Kysely, sql } from 'kysely'

// A person's favorite cards and card boards, listed on the views landing
// page. A card favorite names the view it opens on as the client does (a
// stored view's uuid or a built-in's `builtin.…` id), so `view_id` has no FK;
// a board favorite has none. A row goes with its person and its record.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('views_favorites')
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'text', col => col.notNull().check(sql`kind IN ('card', 'board')`))
    .addColumn('record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('view_id', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_favorites_pk', ['user_id', 'kind', 'record_id'])
    .addCheckConstraint('views_favorites_card_view', sql`(kind = 'card') = (view_id IS NOT NULL)`)
    .execute()
  await db.schema.createIndex('views_favorites_record_idx').on('views_favorites').column('record_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('views_favorites').execute()
}
