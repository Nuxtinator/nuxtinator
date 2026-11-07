import { type Kysely, sql } from 'kysely'

// The views tables. Cards and items reference records_entries, which the
// records layer's rename (records_001) produces; `views_` sorts after it.
//
// - views_definitions: one row per view — record type, who can open it
//   (visibility + views_teams + views_shares), base filter and whether it
//   holds hand-picked records (definition.picked).
// - views_shares / views_teams: people and teams a view is shared with. A
//   level is 'view' or 'edit'; on teams and on org-wide visibility only
//   'edit' is stored, and no value means 'view'.
// - views_tabs: a view's tabs, ordered by a fractional-index `position`.
// - views_items: the records of a hand-picked view; `created_here` marks the
//   ones created on that view.
// - views_cards: card positions and manual order per tab.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('views_definitions')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('icon', 'text')
    .addColumn('record_type_key', 'text', col => col.notNull())
    .addColumn('visibility', 'text', col =>
      col.notNull().defaultTo('private').check(sql`visibility IN ('private', 'org', 'teams')`))
    .addColumn('org_level', 'text', col => col.check(sql`org_level = 'edit'`))
    .addColumn('owner_id', 'uuid', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('definition', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema.createIndex('views_definitions_owner_idx').on('views_definitions').column('owner_id').execute()
  await db.schema.createIndex('views_definitions_visibility_idx').on('views_definitions').column('visibility').execute()

  await db.schema
    .createTable('views_shares')
    .addColumn('view_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('level', 'text', col => col.notNull().check(sql`level IN ('view', 'edit')`))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_shares_pk', ['view_id', 'user_id'])
    .execute()
  await db.schema.createIndex('views_shares_user_idx').on('views_shares').column('user_id').execute()

  await db.schema
    .createTable('views_teams')
    .addColumn('container_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('group_id', 'uuid', col => col.notNull().references('groups.id').onDelete('restrict'))
    .addColumn('level', 'text', col => col.check(sql`level = 'edit'`))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_teams_pkey', ['container_id', 'group_id'])
    .execute()
  await db.schema.createIndex('views_teams_group_idx').on('views_teams').column('group_id').execute()

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
  await db.schema.createIndex('views_tabs_view_position_idx').on('views_tabs').columns(['view_id', 'position']).execute()

  await db.schema
    .createTable('views_items')
    .addColumn('view_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('created_here', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_items_pk', ['view_id', 'record_id'])
    .execute()
  // Record visibility and edit checks look items up by record.
  await db.schema.createIndex('views_items_record_idx').on('views_items').column('record_id').execute()

  await db.schema
    .createTable('views_cards')
    .addColumn('view_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('tab_id', 'uuid', col => col.notNull().references('views_tabs.id').onDelete('cascade'))
    .addColumn('record_id', 'uuid', col => col.notNull().references('records_entries.id').onDelete('cascade'))
    .addColumn('column_key', 'text', col => col.notNull().defaultTo(''))
    .addColumn('rank', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_cards_pk', ['tab_id', 'record_id', 'column_key'])
    .execute()
  await db.schema.createIndex('views_cards_tab_column_idx').on('views_cards').columns(['tab_id', 'column_key']).execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['views_cards', 'views_items', 'views_tabs', 'views_teams', 'views_shares', 'views_definitions']) {
    await db.schema.dropTable(table).execute()
  }
}
