import { type Kysely, sql } from 'kysely'

// crm_records is the polymorphic record store: one row per CRM record of any
// type (contacts, admin-created types, ...). `record_type` is an open,
// registry-owned vocabulary — no CHECK. `name` and `status` are promoted
// columns (fields every type surfaces in lists); everything else a manifest
// declares as jsonb-storage lives in `data`.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('crm_records')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('record_type', 'text', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('status', 'text')
    .addColumn('data', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_by', 'uuid', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('crm_records_type_idx')
    .on('crm_records')
    .column('record_type')
    .execute()

  await db.schema
    .createIndex('crm_records_type_status_idx')
    .on('crm_records')
    .columns(['record_type', 'status'])
    .execute()

  // Default list ordering: newest activity first within a type.
  await sql`
    CREATE INDEX crm_records_type_updated_idx
      ON crm_records (record_type, updated_at DESC)
  `.execute(db)

  // Containment queries against jsonb-stored fields (list filters).
  await sql`
    CREATE INDEX crm_records_data_gin_idx
      ON crm_records USING gin (data jsonb_path_ops)
  `.execute(db)

  // Case-insensitive name search/sort within a type.
  await sql`
    CREATE INDEX crm_records_type_name_idx
      ON crm_records (record_type, lower(name))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('crm_records').execute()
}
