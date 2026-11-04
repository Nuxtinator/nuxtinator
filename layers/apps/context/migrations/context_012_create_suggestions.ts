import { type Kysely, sql } from 'kysely'

// Suggested section updates awaiting review. A set is one submission (one MCP
// update call) and holds one suggestion per section it touches. Each
// suggestion keeps the content it was based on so a reviewer can see whether
// the section changed since. Versions written by an approval link back to the
// suggestion they came from.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE context_suggestion_sets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      portfolio_id uuid NOT NULL REFERENCES context_portfolios(id) ON DELETE CASCADE,
      author_id uuid REFERENCES users(id) ON DELETE SET NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX context_suggestion_sets_portfolio_idx
      ON context_suggestion_sets (portfolio_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE context_suggestions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      set_id uuid NOT NULL REFERENCES context_suggestion_sets(id) ON DELETE CASCADE,
      portfolio_id uuid NOT NULL REFERENCES context_portfolios(id) ON DELETE CASCADE,
      section_key text NOT NULL,
      base_content text NOT NULL,
      proposed_content text NOT NULL,
      status text NOT NULL,
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      decided_at timestamptz,
      review_note text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX context_suggestions_set_idx ON context_suggestions (set_id)
  `.execute(db)
  await sql`
    CREATE INDEX context_suggestions_pending_section_idx
      ON context_suggestions (portfolio_id, section_key)
      WHERE status = 'pending'
  `.execute(db)

  await sql`
    ALTER TABLE context_section_versions
      ADD COLUMN suggestion_id uuid REFERENCES context_suggestions(id) ON DELETE SET NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_section_versions DROP COLUMN IF EXISTS suggestion_id`.execute(db)
  await sql`DROP TABLE IF EXISTS context_suggestions`.execute(db)
  await sql`DROP TABLE IF EXISTS context_suggestion_sets`.execute(db)
}
