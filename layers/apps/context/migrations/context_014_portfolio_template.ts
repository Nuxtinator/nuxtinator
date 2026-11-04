import { type Kysely, sql } from 'kysely'

// The registered portfolio template a portfolio was created from. Only the id
// is stored; NULL = the default template. Template section titles,
// descriptions, and order resolve from code.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_portfolios ADD COLUMN template text`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_portfolios DROP COLUMN IF EXISTS template`.execute(db)
}
