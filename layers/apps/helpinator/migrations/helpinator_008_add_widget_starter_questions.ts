import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Suggested questions shown as clickable chips before a visitor's first
// message. Plain text, in display order; empty means none.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('helpinator_widgets')
    .addColumn('starter_questions', sql`text[]`, col => col.notNull().defaultTo(sql`'{}'::text[]`))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('helpinator_widgets').dropColumn('starter_questions').execute()
}
