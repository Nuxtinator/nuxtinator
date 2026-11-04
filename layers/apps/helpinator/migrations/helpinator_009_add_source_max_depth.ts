import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// How many links deep a URL entry's crawl follows from its start page: 0 is
// the page alone, 1 (the old fixed behaviour) the pages it links to, and so
// on. `max_pages` still caps the total. The upper bound lives in the app
// (HELPINATOR_MAX_DEPTH), like `max_pages`'s, so raising it needs no migration.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('helpinator_library_sources')
    .addColumn('max_depth', 'integer', col => col.notNull().defaultTo(1).check(sql`max_depth >= 0`))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('helpinator_library_sources').dropColumn('max_depth').execute()
}
