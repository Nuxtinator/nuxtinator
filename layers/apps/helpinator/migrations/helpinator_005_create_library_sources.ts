import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// One URL entry of a website library: the start page plus the same-host pages
// one link away (optionally only those under the start path), capped at
// `max_pages`. `status` / `run_token` track the crawl: a new sync stamps a
// fresh run_token and an older run still writing sees the mismatch and stops.
// `run_total` / `run_done` are the current run's live progress (reset when a
// run starts; `page_count` / `bytes` stay the last finished run's), and
// `run_heartbeat_at` is touched on every progress write — a `syncing` source
// whose heartbeat goes quiet belonged to a process that died mid-run, and
// readers mark it interrupted.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('helpinator_library_sources')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('library_id', 'uuid', col => col.notNull().references('helpinator_libraries.id').onDelete('cascade'))
    .addColumn('url', 'text', col => col.notNull())
    .addColumn('restrict_to_path', 'boolean', col => col.notNull().defaultTo(true))
    .addColumn('max_pages', 'integer', col => col.notNull().defaultTo(200))
    .addColumn('status', 'text', col => col.notNull().defaultTo('idle').check(sql`status in ('idle', 'syncing', 'done', 'error')`))
    .addColumn('run_token', 'uuid')
    .addColumn('run_started_at', 'timestamptz')
    .addColumn('run_heartbeat_at', 'timestamptz')
    .addColumn('run_total', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('run_done', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('page_count', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('bytes', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('last_synced_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('helpinator_library_sources_library_url_uq', ['library_id', 'url'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('helpinator_library_sources').ifExists().execute()
}
