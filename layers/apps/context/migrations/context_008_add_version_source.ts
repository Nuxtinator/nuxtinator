import { type Kysely, sql } from 'kysely'

// Records how a version was produced: 'user' (direct edit), 'assistant'
// (accepted in-app AI proposal), or 'mcp' (AI client writing through MCP).
// Nullable with no default: rows from before this column exist have unknown
// provenance, and the label for each key lives in code.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_section_versions ADD COLUMN source text`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_section_versions DROP COLUMN IF EXISTS source`.execute(db)
}
