import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// One crawled page, as markdown (readability-extracted). Unique by URL within
// a library: the first source to crawl a URL owns it, other sources skip it.
// `content_hash` lets a re-crawl skip re-embedding an unchanged page.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('helpinator_library_pages')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('library_id', 'uuid', col => col.notNull().references('helpinator_libraries.id').onDelete('cascade'))
    .addColumn('source_id', 'uuid', col => col.notNull().references('helpinator_library_sources.id').onDelete('cascade'))
    .addColumn('url', 'text', col => col.notNull())
    .addColumn('title', 'text', col => col.notNull().defaultTo(''))
    .addColumn('content', 'text', col => col.notNull().defaultTo(''))
    .addColumn('content_hash', 'text', col => col.notNull())
    .addColumn('bytes', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('fetched_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('helpinator_library_pages_library_url_uq', ['library_id', 'url'])
    .execute()
  await db.schema
    .createIndex('helpinator_library_pages_source_idx')
    .on('helpinator_library_pages')
    .column('source_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('helpinator_library_pages').ifExists().execute()
}
