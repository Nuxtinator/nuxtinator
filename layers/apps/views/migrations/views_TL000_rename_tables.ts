import { type Kysely, sql } from 'kysely'

// Renames the views tables forward again after workflows_T000 put the
// workflows_* names back for workflows_T001. Sorts before views_TL001 and
// does nothing when the tables already carry the views_* names.

const TABLES: Array<[string, string]> = [
  ['workflows_views', 'views_definitions'],
  ['workflows_view_shares', 'views_shares'],
  ['workflows_view_cards', 'views_cards']
]

export async function up(db: Kysely<unknown>): Promise<void> {
  const res = await sql<{ restored: boolean }>`
    select to_regclass('workflows_views') is not null and to_regclass('views_definitions') is null as restored
  `.execute(db)
  if (!res.rows[0]?.restored) return
  for (const [oldName, newName] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(oldName)} RENAME TO ${sql.ref(newName)}`.execute(db)
  }
}

export async function down(): Promise<void> {}
