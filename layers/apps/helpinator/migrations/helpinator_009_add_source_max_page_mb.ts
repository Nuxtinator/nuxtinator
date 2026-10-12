import type { Kysely } from 'kysely'

// Per-entry cap on one page's HTML, in MB. A page over it is not read: the
// crawl keeps its last good copy and names it in the entry's notice.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('helpinator_library_sources')
    .addColumn('max_page_mb', 'integer', col => col.notNull().defaultTo(2))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('helpinator_library_sources').dropColumn('max_page_mb').execute()
}
