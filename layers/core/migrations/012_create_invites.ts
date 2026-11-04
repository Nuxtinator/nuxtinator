import { type Kysely, sql } from 'kysely'

// Pending invitations. An invite is not a user: the `users` row is created
// only when someone accepts, so nothing can reference a person who hasn't
// joined yet. `email` is set for invites sent to an address and NULL for
// shareable single-use links. Only the SHA-256 of the token is stored.
//
// The tenancy layer adds `invite_orgs` (org + roles per invite) on top.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('invites')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('token_hash', 'text', col => col.notNull().unique())
    .addColumn('email', 'text')
    .addColumn('display_name', 'text')
    .addColumn('invited_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', col => col.notNull())
    .addColumn('accepted_at', 'timestamptz')
    .addColumn('accepted_by', 'uuid', col => col.references('users.id').onDelete('set null'))
    .execute()

  await db.schema.createIndex('invites_email_idx').on('invites').expression(sql`lower(email)`).execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('invites').execute()
}
