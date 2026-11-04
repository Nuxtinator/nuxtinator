import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// One row per AI round trip: which feature and model ran, on whose key, the
// tokens it used and what it cost in USD. `cost` is null when neither the
// provider nor the model's catalog prices said what the call cost.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ai_usage')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('feature', 'text', col => col.notNull())
    .addColumn('model', 'text', col => col.notNull())
    .addColumn('provider', 'text', col => col.notNull())
    .addColumn('key_source', 'text', col => col.notNull())
    .addColumn('prompt_tokens', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('completion_tokens', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('cost', sql`numeric(14, 8)`)
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('ai_usage_key_source_check', sql`key_source in ('org', 'host')`)
    .execute()
  await sql`CREATE INDEX ai_usage_created_at_idx ON ai_usage (created_at)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ai_usage').ifExists().execute()
}
