import { type Kysely, sql } from 'kysely'

// Records whether a section was created as custom, so a template that later
// declares the same key can't turn it into a built-in. The keys below are the
// default catalog when this was written, frozen so it never reads live code.
const DEFAULT_TEMPLATE_KEYS = [
  'identity',
  'vision-and-values',
  'team',
  'goals-and-priorities',
  'communication-style',
  'personas',
  'tools-and-systems',
  'translation',
  'decision-log'
]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE context_section_definitions
      ADD COLUMN is_custom boolean NOT NULL DEFAULT false
  `.execute(db)

  const keys = sql.join(DEFAULT_TEMPLATE_KEYS.map(k => sql`${k}`), sql`, `)
  await sql`
    UPDATE context_section_definitions d
    SET is_custom = true
    FROM context_portfolios p
    WHERE p.id = d.portfolio_id
      AND p.template IS NULL
      AND d.key NOT IN (${keys})
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE context_section_definitions DROP COLUMN IF EXISTS is_custom`.execute(db)
}
