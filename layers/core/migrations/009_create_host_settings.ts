import { type Kysely, sql } from 'kysely'

// Deployment-global settings store: the host-level counterpart of
// `core_settings`. Same row shape and the same registry-first merge (see
// settings-store.ts `getHostSetting` / `setHostSetting`), but the tenancy
// layer never retrofits this table, so one row is one value for the whole
// deployment in both single- and multi-tenant mode. For settings an operator
// admin decides once for everyone — e.g. which AI models the shared API key
// may spend on — rather than per-org preferences.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('core_host_settings')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('namespace', 'text', col => col.notNull())
    .addColumn('key', 'text', col => col.notNull())
    .addColumn('value', 'jsonb', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('core_host_settings_scope_key', ['namespace', 'key'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('core_host_settings').execute()
}
