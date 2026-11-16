import { type Kysely, sql } from 'kysely'

// The reminder queue: the day each record's reminder falls on, stamped once sent.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('records_reminders')
    .addColumn('record_id', 'uuid', col => col.primaryKey().references('records_entries.id').onDelete('cascade'))
    .addColumn('remind_on', 'date', col => col.notNull())
    .addColumn('set_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('sent_at', 'timestamptz')
    .execute()
  await sql`
    CREATE INDEX records_reminders_due_idx ON records_reminders (remind_on) WHERE sent_at IS NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('records_reminders').execute()
}
