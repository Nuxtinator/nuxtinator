import { type Kysely, sql } from 'kysely'

// One row per signed-in device. The client holds a short-lived access JWT
// (carrying this row's id as `sid`) plus an opaque refresh token whose SHA-256
// lives here. Each refresh rotates the token; the previous hash is kept for a
// short grace window so concurrent requests racing the same rotation don't log
// the device out. Deleting a row revokes the session.
//
// `authenticated_at` is when the user last proved who they are on this device
// (password or provider sign-in); sensitive endpoints require it to be recent.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('client', 'text', col => col.notNull())
    .addColumn('refresh_token_hash', 'text', col => col.notNull())
    .addColumn('previous_refresh_token_hash', 'text')
    .addColumn('rotated_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', col => col.notNull())
    .addColumn('authenticated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('user_agent', 'text')
    .addColumn('ip', 'text')
    .execute()

  await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sessions').execute()
}
