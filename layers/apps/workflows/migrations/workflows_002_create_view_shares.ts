import { type Kysely, sql } from 'kysely'

// Per-view sharing grants for views with visibility = 'shared'. A share never
// widens record access — it only makes the view itself reachable. 'view'
// allows opening the view, dragging cards, and editing card details (all
// still subject to CRM's record permissions); 'edit' additionally allows
// changing the view definition (columns, filters, sort, card fields).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('workflows_view_shares')
    .addColumn('view_id', 'uuid', col => col.notNull().references('workflows_views.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('level', 'text', col =>
      col.notNull().defaultTo('view').check(sql`level IN ('view', 'edit')`))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('workflows_view_shares_pk', ['view_id', 'user_id'])
    .execute()

  // "Views shared with this user" — the accessible-views listing entry point.
  await db.schema
    .createIndex('workflows_view_shares_user_idx')
    .on('workflows_view_shares')
    .column('user_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('workflows_view_shares').execute()
}
