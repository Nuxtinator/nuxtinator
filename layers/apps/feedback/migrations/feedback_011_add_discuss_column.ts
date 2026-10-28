import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Add a DISCUSS column between FEEDBACK INBOX and TODO. DISCUSS holds cards
// that have been read but aren't ready to build: ideas that need more
// conversation, questions for the submitter, or a pending decision. Board
// order becomes: FEEDBACK INBOX (1), DISCUSS (2), TODO (3), DOING (4),
// DONE (5), ARCHIVE (6).
//
// Both statements are guarded on DISCUSS's absence so a database that already
// has a DISCUSS column is left untouched.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE columns SET position = position + 1
    WHERE position >= 2
      AND NOT EXISTS (SELECT 1 FROM columns WHERE name = 'DISCUSS')
  `.execute(db)
  await sql`
    INSERT INTO columns (name, position, is_collapsed, post_meta)
    SELECT 'DISCUSS', 2, false, '{}'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM columns WHERE name = 'DISCUSS')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rescue DISCUSS cards back to the inbox before dropping the column.
  await sql`
    UPDATE cards SET column_id = (SELECT id FROM columns WHERE name = 'FEEDBACK INBOX')
    WHERE column_id IN (SELECT id FROM columns WHERE name = 'DISCUSS')
  `.execute(db)
  await sql`DELETE FROM columns WHERE name = 'DISCUSS'`.execute(db)
  await sql`UPDATE columns SET position = position - 1 WHERE position > 2`.execute(db)
}
