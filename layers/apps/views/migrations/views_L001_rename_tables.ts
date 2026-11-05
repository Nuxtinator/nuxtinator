import { type Kysely, sql } from 'kysely'

// The views layer was built as "workflows"; its tables take the layer's
// prefix. A late migration (`_L<NNN>_`, see core's migration-names.ts) so it
// runs after the tenancy retrofit committed against the old names
// (workflows_T001). ALTER ... RENAME only rewrites catalog entries: rows, RLS
// policies, foreign keys and grants follow the table.

const TABLES: Array<[string, string]> = [
  ['workflows_views', 'views_definitions'],
  ['workflows_view_shares', 'views_shares'],
  ['workflows_view_cards', 'views_cards']
]

const INDEXES: Array<[string, string]> = [
  ['workflows_views_owner_idx', 'views_definitions_owner_idx'],
  ['workflows_views_visibility_idx', 'views_definitions_visibility_idx'],
  ['workflows_view_shares_user_idx', 'views_shares_user_idx'],
  ['workflows_view_cards_view_column_idx', 'views_cards_view_column_idx']
]

const CONSTRAINTS: Array<[string, string, string]> = [
  ['views_shares', 'workflows_view_shares_pk', 'views_shares_pk'],
  ['views_cards', 'workflows_view_cards_pk', 'views_cards_pk']
]

async function renameConstraint(db: Kysely<unknown>, table: string, from: string, to: string): Promise<void> {
  const found = await sql<{ present: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${from}) AS present
  `.execute(db)
  if (!found.rows[0]?.present) return
  await sql`ALTER TABLE ${sql.ref(table)} RENAME CONSTRAINT ${sql.ref(from)} TO ${sql.ref(to)}`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [from, to] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(from)} RENAME TO ${sql.ref(to)}`.execute(db)
  }
  for (const [from, to] of INDEXES) {
    await sql`ALTER INDEX IF EXISTS ${sql.ref(from)} RENAME TO ${sql.ref(to)}`.execute(db)
  }
  for (const [table, from, to] of CONSTRAINTS) {
    await renameConstraint(db, table, from, to)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [table, from, to] of CONSTRAINTS) {
    await renameConstraint(db, table, to, from)
  }
  for (const [from, to] of INDEXES) {
    await sql`ALTER INDEX IF EXISTS ${sql.ref(to)} RENAME TO ${sql.ref(from)}`.execute(db)
  }
  for (const [from, to] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(to)} RENAME TO ${sql.ref(from)}`.execute(db)
  }
}
