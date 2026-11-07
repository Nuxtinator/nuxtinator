import { type Kysely, sql } from 'kysely'

// Card ranks and tab positions are fractional-indexing keys, which order by
// byte value (the client compares them with `<`). The "C" collation makes
// Postgres sort them the same way whatever the database's locale.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table views_cards alter column rank type text collate "C"`.execute(db)
  await sql`alter table views_tabs alter column position type text collate "C"`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table views_cards alter column rank type text collate "default"`.execute(db)
  await sql`alter table views_tabs alter column position type text collate "default"`.execute(db)
}
