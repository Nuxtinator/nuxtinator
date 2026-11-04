import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Whether a section's vector chunks match its current content: none (never
// indexed / embeddings not configured / no pgvector), ok, stale (the last
// embed attempt failed — see index_error).
//
// Split from context_013 so it runs without pgvector. Databases where an
// earlier context_013 already added these columns skip them (IF NOT EXISTS).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE context_sections
      ADD COLUMN IF NOT EXISTS index_state text NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS index_error text
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE context_sections
      DROP COLUMN IF EXISTS index_error,
      DROP COLUMN IF EXISTS index_state
  `.execute(db)
}
