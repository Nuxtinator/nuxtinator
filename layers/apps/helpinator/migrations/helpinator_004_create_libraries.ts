import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// A library is a set of content a widget's bot may search and read. Two kinds:
//   website   — pages crawled from URL entries (helpinator_library_sources),
//               stored in helpinator_library_pages and vector-indexed.
//   portfolio — a pointer at a context portfolio; nothing is copied, the bot
//               reads context_sections live and searches the context layer's
//               own chunk index.
// `portfolio_id` is SET NULL when the portfolio goes: the library then reads
// as unavailable rather than vanishing from under the widgets that list it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('helpinator_libraries')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('kind', 'text', col => col.notNull().check(sql`kind in ('website', 'portfolio')`))
    .addColumn('portfolio_id', 'uuid', col => col.references('context_portfolios.id').onDelete('set null'))
    .addColumn('description', 'text', col => col.notNull().defaultTo(''))
    .addColumn('created_by', 'uuid')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('helpinator_libraries').ifExists().execute()
}
