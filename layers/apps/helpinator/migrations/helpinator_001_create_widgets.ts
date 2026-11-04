import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// One embeddable widget = one site. Bound to a list of libraries (the only
// content its bot can read), one of them the default whose index goes in the
// prompt; for a portfolio default, `default_section_key` is preloaded into
// every chat. `library_ids` carries no FK (a uuid[]): a library that goes
// reads as unavailable, and the conversation log survives. `appearance`
// holds only the fields overridden from the code defaults.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('helpinator_widgets')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('library_ids', sql`uuid[]`, col => col.notNull().defaultTo(sql`'{}'::uuid[]`))
    .addColumn('default_library_id', 'uuid')
    .addColumn('default_section_key', 'text')
    .addColumn('allowed_origins', sql`text[]`, col => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('daily_message_cap', 'integer', col => col.notNull().defaultTo(500))
    .addColumn('enabled', 'boolean', col => col.notNull().defaultTo(true))
    .addColumn('appearance', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('extra_instructions', 'text', col => col.notNull().defaultTo(''))
    .addColumn('created_by', 'uuid')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('helpinator_widgets').ifExists().execute()
}
