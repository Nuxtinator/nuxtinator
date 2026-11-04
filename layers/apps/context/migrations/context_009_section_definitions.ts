import { type Kysely, sql } from 'kysely'

// Every section a portfolio has is a row in `context_section_definitions`,
// built-in or custom. A built-in row stores only its key: title, description,
// order, and staleness resolve from the code catalog (`section-catalog.ts`).
// A custom row stores its own title/description/order.
//
// Generalizes the custom-only table and backfills the built-in rows for every
// existing portfolio. The catalog is the template applied when a portfolio is
// created; a built-in added to the catalog later applies only to portfolios
// created after that, unless a user adds it.
//
// The keys below are frozen at the time this migration was written — it must
// not import the live catalog.
const BUILTIN_KEYS = [
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
  await sql`ALTER TABLE context_custom_section_definitions RENAME TO context_section_definitions`.execute(db)
  await sql`ALTER INDEX context_custom_sections_portfolio_key_uq RENAME TO context_section_definitions_portfolio_key_uq`.execute(db)

  await sql`
    ALTER TABLE context_section_definitions
      ALTER COLUMN title DROP NOT NULL,
      ALTER COLUMN description DROP NOT NULL,
      ALTER COLUMN description DROP DEFAULT,
      ALTER COLUMN "order" DROP NOT NULL,
      ALTER COLUMN "order" DROP DEFAULT,
      ALTER COLUMN created_by DROP NOT NULL
  `.execute(db)

  const keyRows = sql.join(BUILTIN_KEYS.map(k => sql`(${k})`), sql`, `)
  await sql`
    INSERT INTO context_section_definitions (portfolio_id, key)
    SELECT p.id, k.key
    FROM context_portfolios p
    CROSS JOIN (VALUES ${keyRows}) AS k(key)
    ON CONFLICT DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM context_section_definitions WHERE title IS NULL`.execute(db)
  await sql`
    UPDATE context_section_definitions
    SET description = COALESCE(description, ''), "order" = COALESCE("order", 0)
  `.execute(db)
  await sql`
    ALTER TABLE context_section_definitions
      ALTER COLUMN title SET NOT NULL,
      ALTER COLUMN description SET NOT NULL,
      ALTER COLUMN description SET DEFAULT '',
      ALTER COLUMN "order" SET NOT NULL,
      ALTER COLUMN "order" SET DEFAULT 0,
      ALTER COLUMN created_by SET NOT NULL
  `.execute(db)
  await sql`ALTER INDEX context_section_definitions_portfolio_key_uq RENAME TO context_custom_sections_portfolio_key_uq`.execute(db)
  await sql`ALTER TABLE context_section_definitions RENAME TO context_custom_section_definitions`.execute(db)
}
