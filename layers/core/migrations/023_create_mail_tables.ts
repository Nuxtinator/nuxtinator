import { type Kysely, sql } from 'kysely'

// The mail kernel's tables (@nuxtinator/mail). Each holds host rows (`org_id`
// NULL) and org rows; the tenancy layer adds the foreign keys to `orgs`.
// None has RLS: webhooks look up accounts and domains before any org is
// known, and processes outside Nuxt read them without an org context, so
// handlers decide access (the `groups` precedent).
//
// Only explicit choices are stored: provider accounts, domains and
// stream-to-domain assignments. Streams and their defaults live in code.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mail_accounts')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid')
    .addColumn('source', 'text', col => col.notNull().defaultTo('ui'))
    .addColumn('provider', 'text')
    .addColumn('label', 'text')
    .addColumn('credentials', 'text')
    .addColumn('capabilities', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('env_fingerprint', 'text')
    .addColumn('webhook_token_version', 'integer', col => col.notNull().defaultTo(1))
    .addColumn('created_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`CREATE UNIQUE INDEX mail_accounts_env_key ON mail_accounts (source) WHERE source = 'env'`.execute(db)
  await db.schema.createIndex('mail_accounts_org_idx').on('mail_accounts').column('org_id').execute()

  await db.schema
    .createTable('mail_domains')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid')
    .addColumn('source', 'text', col => col.notNull().defaultTo('ui'))
    .addColumn('domain', 'text', col => col.notNull())
    .addColumn('ownership_status', 'text', col => col.notNull())
    .addColumn('ownership_token', 'text')
    .addColumn('ownership_failures', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('from_domain', 'text')
    // NO ACTION, not RESTRICT, so deleting an org can remove its accounts and
    // domains in one statement; handlers refuse to delete an account in use.
    .addColumn('send_account_id', 'uuid', col => col.references('mail_accounts.id').onDelete('no action'))
    .addColumn('receive_account_id', 'uuid', col => col.references('mail_accounts.id').onDelete('no action'))
    .addColumn('setup_mode', 'text', col => col.notNull().defaultTo('auto'))
    .addColumn('credentials', 'text')
    .addColumn('capabilities', 'jsonb')
    .addColumn('dkim_selector', 'text')
    .addColumn('probe_token', 'text')
    .addColumn('send_status', 'text', col => col.notNull().defaultTo('pending'))
    .addColumn('receive_status', 'text', col => col.notNull().defaultTo('pending'))
    .addColumn('send_error', 'text')
    .addColumn('dns_records', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('provider_refs', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('webhook_events', 'jsonb')
    .addColumn('last_checked_at', 'timestamptz')
    .addColumn('verified_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  // Only a proven owner holds a name exclusively; orgs may hold pending claims.
  await sql`CREATE UNIQUE INDEX mail_domains_verified_key ON mail_domains (lower(domain)) WHERE ownership_status = 'verified'`.execute(db)
  await sql`CREATE UNIQUE INDEX mail_domains_env_key ON mail_domains (source) WHERE source = 'env'`.execute(db)
  await db.schema.createIndex('mail_domains_org_idx').on('mail_domains').column('org_id').execute()
  await sql`CREATE INDEX mail_domains_name_idx ON mail_domains (lower(domain))`.execute(db)

  await db.schema
    .createTable('mail_stream_routes')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid')
    .addColumn('stream', 'text', col => col.notNull())
    .addColumn('domain_id', 'uuid', col => col.notNull().references('mail_domains.id').onDelete('cascade'))
    .execute()
  await sql`
    CREATE UNIQUE INDEX mail_stream_routes_scope_key
      ON mail_stream_routes ((coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)), stream)
  `.execute(db)
  await db.schema.createIndex('mail_stream_routes_domain_idx').on('mail_stream_routes').column('domain_id').execute()

  await db.schema
    .createTable('mail_suppressions')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('address_hash', 'text', col => col.notNull())
    .addColumn('org_id', 'uuid')
    .addColumn('scope', 'text', col => col.notNull())
    .addColumn('reason', 'text', col => col.notNull())
    .addColumn('detail', 'text')
    .addColumn('source', 'text')
    .addColumn('account_id', 'uuid', col => col.references('mail_accounts.id').onDelete('set null'))
    .addColumn('occurred_at', 'timestamptz', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('cleared_at', 'timestamptz')
    .addColumn('cleared_reason', 'text')
    .execute()
  // One active row per address, scope, org and reason; cleared rows stay as history.
  await sql`
    CREATE UNIQUE INDEX mail_suppressions_active_key
      ON mail_suppressions (address_hash, scope, (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)), reason)
      WHERE cleared_at IS NULL
  `.execute(db)
  await db.schema.createIndex('mail_suppressions_org_idx').on('mail_suppressions').column('org_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('mail_suppressions').execute()
  await db.schema.dropTable('mail_stream_routes').execute()
  await db.schema.dropTable('mail_domains').execute()
  await db.schema.dropTable('mail_accounts').execute()
}
