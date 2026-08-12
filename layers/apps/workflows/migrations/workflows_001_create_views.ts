import { type Kysely, sql } from 'kysely'

// workflows_views is the view store: one row per user-created view (kanban
// board or table) over a CRM record type. `record_type_key` is a plain text
// key into CRM's type registry — no FK, because types can be code-registered
// manifests that have no crm_record_types row.
//
// `definition` holds only explicit choices (grouping field or custom columns,
// card fields, saved filters, sort); rendering defaults live in code. The
// vocabularies mirrored by CHECK constraints (view_type, visibility) are
// code-owned.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('workflows_views')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('icon', 'text')
    .addColumn('record_type_key', 'text', col => col.notNull())
    .addColumn('view_type', 'text', col => col.notNull().check(sql`view_type IN ('kanban', 'table')`))
    .addColumn('visibility', 'text', col =>
      col.notNull().defaultTo('private').check(sql`visibility IN ('private', 'shared', 'org')`))
    .addColumn('owner_id', 'uuid', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('definition', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  // "My views" and the org-wide listing both enter through these.
  await db.schema
    .createIndex('workflows_views_owner_idx')
    .on('workflows_views')
    .column('owner_id')
    .execute()

  await db.schema
    .createIndex('workflows_views_visibility_idx')
    .on('workflows_views')
    .column('visibility')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('workflows_views').execute()
}
