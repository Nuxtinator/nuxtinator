import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// The server-authoritative transcript, for the read-only staff log. Per
// reply: `pages_loaded` — what the bot read (`{ ref, title, url? }[]`, the
// preloaded section first); `searches` — the queries it ran with the search
// tool; `search_hits` — every page search surfaced (the auto-search on the
// visitor's message plus tool searches), best-first. Most replies rest on the
// hits alone, so without them the log couldn't show where an answer came from.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('helpinator_messages')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('conversation_id', 'uuid', col => col.notNull().references('helpinator_conversations.id').onDelete('cascade'))
    .addColumn('role', 'text', col => col.notNull().check(sql`role in ('user', 'assistant')`))
    .addColumn('content', 'text', col => col.notNull())
    .addColumn('pages_loaded', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('searches', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('search_hits', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('model', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('helpinator_messages_conversation_idx')
    .on('helpinator_messages')
    .columns(['conversation_id', 'created_at'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('helpinator_messages').ifExists().execute()
}
