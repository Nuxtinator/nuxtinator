import { type Kysely, sql } from 'kysely'

// A view holds tabs. The view keeps its name, icon, record type, sharing,
// base filter and hand-picked records; each tab has its own layout (board,
// table or list), grouping or columns, card fields, sort and filter.
//
// - views_tabs: one row per tab, ordered by a fractional-index `position`.
// - views_items: the hand-picked records of a view whose tabs show only
//   records added to it (definition.picked).
// - views_cards: card positions and manual order, now per tab.
//
// Every existing view becomes a view with one tab carrying its layout and
// definition; a board with its own columns becomes a hand-picked view. Saved
// filters (one condition per field) become a filter tree on the tab.

type OldFilters = Record<string, unknown>

interface Rule { field: string, op: string, value?: unknown }

function convertFilters(filters: OldFilters): { match: 'all', rules: Rule[] } {
  const rules: Rule[] = []
  for (const [field, raw] of Object.entries(filters)) {
    if (raw === null) {
      rules.push({ field, op: 'empty' })
    } else if (typeof raw === 'object' && !Array.isArray(raw)) {
      const ops = raw as { in?: unknown[], contains?: string, gte?: unknown, lte?: unknown }
      if (ops.in) rules.push({ field, op: 'any_of', value: ops.in })
      if (ops.contains !== undefined) rules.push({ field, op: 'contains', value: ops.contains })
      if (ops.gte !== undefined && ops.lte !== undefined) rules.push({ field, op: 'between', value: [ops.gte, ops.lte] })
      else if (ops.gte !== undefined) rules.push({ field, op: 'after', value: ops.gte })
      else if (ops.lte !== undefined) rules.push({ field, op: 'before', value: ops.lte })
    } else if (typeof raw === 'number') {
      rules.push({ field, op: 'eq', value: raw })
    } else if (typeof raw === 'boolean') {
      rules.push({ field, op: 'is', value: raw })
    } else {
      rules.push({ field, op: 'any_of', value: [raw] })
    }
  }
  return { match: 'all', rules }
}

async function primaryKeyName(db: Kysely<unknown>, table: string): Promise<string | null> {
  const res = await sql<{ conname: string }>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = ${table}::regclass AND contype = 'p'
  `.execute(db)
  return res.rows[0]?.conname ?? null
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('views_tabs')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('view_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('layout', 'text', col => col.notNull().check(sql`layout IN ('kanban', 'table', 'list')`))
    .addColumn('position', 'text', col => col.notNull())
    .addColumn('definition', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createIndex('views_tabs_view_position_idx')
    .on('views_tabs')
    .columns(['view_id', 'position'])
    .execute()

  await db.schema
    .createTable('views_items')
    .addColumn('view_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_items_pk', ['view_id', 'record_id'])
    .execute()
  // The visibility source looks records up by id.
  await db.schema
    .createIndex('views_items_record_idx')
    .on('views_items')
    .column('record_id')
    .execute()

  await sql`
    ALTER TABLE views_cards
      ADD COLUMN tab_id uuid REFERENCES views_tabs(id) ON DELETE CASCADE
  `.execute(db)

  const views = await sql<{ id: string, view_type: string, definition: Record<string, unknown> }>`
    SELECT id, view_type, definition FROM views_definitions
  `.execute(db)
  for (const view of views.rows) {
    const { filters, ...rest } = view.definition ?? {}
    const tabDefinition: Record<string, unknown> = { ...rest }
    if (filters && typeof filters === 'object' && Object.keys(filters).length > 0) {
      tabDefinition.filter = convertFilters(filters as OldFilters)
    }
    const picked = !!rest.columns
    const tab = await sql<{ id: string }>`
      INSERT INTO views_tabs (view_id, name, layout, position, definition)
      VALUES (
        ${view.id},
        ${view.view_type === 'kanban' ? 'Board' : 'Table'},
        ${view.view_type},
        'a0',
        ${JSON.stringify(tabDefinition)}::text::jsonb
      )
      RETURNING id
    `.execute(db)
    const tabId = tab.rows[0]!.id
    await sql`
      UPDATE views_definitions
      SET definition = ${JSON.stringify(picked ? { picked: true } : {})}::text::jsonb
      WHERE id = ${view.id}
    `.execute(db)
    await sql`UPDATE views_cards SET tab_id = ${tabId} WHERE view_id = ${view.id}`.execute(db)
    if (picked) {
      await sql`
        INSERT INTO views_items (view_id, record_id)
        SELECT DISTINCT view_id, record_id FROM views_cards WHERE view_id = ${view.id}
        ON CONFLICT DO NOTHING
      `.execute(db)
    }
  }

  await sql`ALTER TABLE views_cards ALTER COLUMN tab_id SET NOT NULL`.execute(db)
  const pk = await primaryKeyName(db, 'views_cards')
  if (pk) await sql`ALTER TABLE views_cards DROP CONSTRAINT ${sql.ref(pk)}`.execute(db)
  await sql`
    ALTER TABLE views_cards
      ADD CONSTRAINT views_cards_pk PRIMARY KEY (tab_id, record_id, column_key)
  `.execute(db)
  await sql`DROP INDEX IF EXISTS views_cards_view_column_idx`.execute(db)
  await db.schema
    .createIndex('views_cards_tab_column_idx')
    .on('views_cards')
    .columns(['tab_id', 'column_key'])
    .execute()

  await sql`ALTER TABLE views_definitions DROP COLUMN view_type`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE views_definitions
      ADD COLUMN view_type text NOT NULL DEFAULT 'table'
        CHECK (view_type IN ('kanban', 'table'))
  `.execute(db)
  // Each view takes back its first tab's layout and definition.
  await sql`
    UPDATE views_definitions v
    SET view_type = CASE WHEN t.layout = 'kanban' THEN 'kanban' ELSE 'table' END,
        definition = t.definition - 'filter'
    FROM (
      SELECT DISTINCT ON (view_id) view_id, layout, definition
      FROM views_tabs ORDER BY view_id, position
    ) t
    WHERE t.view_id = v.id
  `.execute(db)
  await sql`ALTER TABLE views_definitions ALTER COLUMN view_type DROP DEFAULT`.execute(db)

  await sql`DROP INDEX IF EXISTS views_cards_tab_column_idx`.execute(db)
  await sql`
    DELETE FROM views_cards c
    USING views_tabs t
    WHERE t.id = c.tab_id
      AND t.position <> (SELECT min(position) FROM views_tabs f WHERE f.view_id = t.view_id)
  `.execute(db)
  await sql`ALTER TABLE views_cards DROP CONSTRAINT IF EXISTS views_cards_pk`.execute(db)
  await sql`
    ALTER TABLE views_cards
      ADD CONSTRAINT views_cards_pk PRIMARY KEY (view_id, record_id, column_key)
  `.execute(db)
  await sql`ALTER TABLE views_cards DROP COLUMN tab_id`.execute(db)
  await db.schema
    .createIndex('views_cards_view_column_idx')
    .on('views_cards')
    .columns(['view_id', 'column_key'])
    .execute()

  await db.schema.dropTable('views_items').execute()
  await db.schema.dropTable('views_tabs').execute()
}
