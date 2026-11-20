import { type Kysely, sql } from 'kysely'

// A record's place among the records directly under the same parent (a
// feature's tasks), shared by everyone who sees them: a fractional-indexing
// key, null until someone places it. The "C" collation sorts the keys by
// byte value, the way they are generated.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE records_entries ADD COLUMN position text COLLATE "C"`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE records_entries DROP COLUMN position`.execute(db)
}
