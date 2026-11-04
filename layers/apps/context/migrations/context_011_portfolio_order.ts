import { type Kysely, sql } from 'kysely'

// A portfolio's position in the org's portfolio list, set from the Context
// settings page. NULL = never placed; those sort after placed ones, by name.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_portfolios ADD COLUMN "order" integer`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_portfolios DROP COLUMN IF EXISTS "order"`.execute(db)
}
