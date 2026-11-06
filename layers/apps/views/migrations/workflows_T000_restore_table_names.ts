import { type Kysely, sql } from 'kysely'

// workflows_T001 was written against the workflows_* table names. On a
// database where views_L001 renamed those tables before the tenancy layer was
// loaded, this puts the old names back so it runs; views_TL000 renames them
// forward again afterwards. Sorts before workflows_T001 and does nothing
// while the old names are in place.

const TABLES: Array<[string, string]> = [
  ['workflows_views', 'views_definitions'],
  ['workflows_view_shares', 'views_shares'],
  ['workflows_view_cards', 'views_cards']
]

export async function up(db: Kysely<unknown>): Promise<void> {
  const res = await sql<{ renamed: boolean }>`
    select to_regclass('workflows_views') is null and to_regclass('views_definitions') is not null as renamed
  `.execute(db)
  if (!res.rows[0]?.renamed) return
  for (const [oldName, newName] of TABLES) {
    await sql`ALTER TABLE ${sql.ref(newName)} RENAME TO ${sql.ref(oldName)}`.execute(db)
  }
}

export async function down(): Promise<void> {}
