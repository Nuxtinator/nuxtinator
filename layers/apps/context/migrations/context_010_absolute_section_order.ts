import { type Kysely, sql } from 'kysely'

// A stored `order` on a section definition is the section's absolute position
// in the portfolio, for built-in and custom rows alike, so the two kinds can
// interleave. Custom rows previously stored an offset counted from the end of
// the built-ins; this shifts those values into the absolute space so every
// portfolio keeps the order it already showed.
//
// 9 is the number of built-in sections at the time this migration was written
// — frozen here because a migration must not read the live catalog.
const BUILTIN_CEILING = 9

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE context_section_definitions
    SET "order" = "order" + ${BUILTIN_CEILING} + 1
    WHERE title IS NOT NULL AND "order" IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE context_section_definitions
    SET "order" = GREATEST("order" - ${BUILTIN_CEILING} - 1, 0)
    WHERE title IS NOT NULL AND "order" IS NOT NULL
  `.execute(db)
}
