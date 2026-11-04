import { type Kysely, sql } from 'kysely'

// Team restriction for portfolios (core's team-access.ts): `visibility` is
// 'org' (everyone in the org) or 'teams' (only the teams listed in
// context_portfolio_teams). A team in use can't be deleted from under it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE context_portfolios
      ADD COLUMN visibility text NOT NULL DEFAULT 'org'
        CHECK (visibility IN ('org', 'teams'))
  `.execute(db)
  await sql`
    CREATE TABLE context_portfolio_teams (
      container_id uuid NOT NULL REFERENCES context_portfolios(id) ON DELETE CASCADE,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (container_id, group_id)
    )
  `.execute(db)
  await sql`CREATE INDEX context_portfolio_teams_group_idx ON context_portfolio_teams (group_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS context_portfolio_teams`.execute(db)
  await sql`ALTER TABLE context_portfolios DROP COLUMN IF EXISTS visibility`.execute(db)
}
