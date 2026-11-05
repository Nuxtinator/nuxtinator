import { type Kysely, sql } from 'kysely'

// Share levels: a share row grants either read-only visibility ('view') or
// record-scoped update capability ('edit') — an edit share lets a user
// without the type-wide update permission edit exactly that record. The
// level vocabulary is code-owned forever, so a CHECK constraint is allowed
// (same rule as consent status / suppression reason).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('crm_record_shares')
    .addColumn('level', 'text', col => col
      .notNull()
      .defaultTo('view')
      .check(sql`level IN ('view', 'edit')`))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('crm_record_shares')
    .dropColumn('level')
    .execute()
}
