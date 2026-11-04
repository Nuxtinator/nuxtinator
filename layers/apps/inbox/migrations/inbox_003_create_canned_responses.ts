import { type Kysely, sql } from 'kysely'

// Canned responses — shared, org-wide reply snippets an agent can insert into
// the composer. Single-body (HTML): the monorepo has no i18n system yet, so
// there is no translations table. `created_by` is SET NULL, not CASCADE — a
// snippet is a shared team asset that must outlive the teammate who authored it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('inbox_canned_responses')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('title', 'text', col => col.notNull())
    .addColumn('body_html', 'text', col => col.notNull().defaultTo(''))
    .addColumn('created_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  // The manager and picker both list title-ascending.
  await sql`CREATE INDEX inbox_canned_responses_title_idx ON inbox_canned_responses (title)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('inbox_canned_responses').execute()
}
