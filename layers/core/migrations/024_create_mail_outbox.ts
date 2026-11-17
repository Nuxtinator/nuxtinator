import { type Kysely, sql } from 'kysely'

// The mail kernel's outbox. `message` holds the mail sealed to the outbox
// public key and is cleared once the row is sent or finally fails. A row is
// held by one claim at a time (`claimed_by`, `claimed_until`);
// `attempt_started_at` marks a provider call in flight.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mail_outbox')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid')
    .addColumn('stream', 'text', col => col.notNull())
    .addColumn('message', 'text')
    .addColumn('status', 'text', col => col.notNull().defaultTo('queued'))
    .addColumn('attempts', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('claimed_by', 'text')
    .addColumn('claimed_until', 'timestamptz')
    .addColumn('attempt_started_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('provider_message_id', 'text')
    .addColumn('expires_at', 'timestamptz', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('sent_at', 'timestamptz')
    .execute()
  await sql`CREATE INDEX mail_outbox_due_idx ON mail_outbox (next_attempt_at) WHERE status = 'queued'`.execute(db)
  await sql`CREATE INDEX mail_outbox_sending_idx ON mail_outbox (claimed_until) WHERE status = 'sending'`.execute(db)
  await db.schema.createIndex('mail_outbox_org_idx').on('mail_outbox').column('org_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('mail_outbox').execute()
}
