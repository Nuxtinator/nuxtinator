import { type Kysely, sql } from 'kysely'

// The portfolios whose content reached the model for an assistant reply, so a
// conversation can be hidden once any of them is hidden from the caller's
// teams. NULL on messages written before this was recorded.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_assistant_messages ADD COLUMN portfolio_ids uuid[]`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_assistant_messages DROP COLUMN IF EXISTS portfolio_ids`.execute(db)
}
