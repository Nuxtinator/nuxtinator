import { type Kysely, sql } from 'kysely'

// A Google or Apple account linked to a user. Matched on the provider's
// stable subject id, never on email, so a changed email doesn't break the
// link. One identity per provider per user; each identity belongs to one user.
//
// `refresh_token_enc` (Apple only) is kept, encrypted, so deleting the account
// can revoke the app's access at Apple. `client_id` records which Apple client
// (Services ID or bundle ID) issued it, since revocation must use the same one.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('user_identities')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('provider', 'text', col => col.notNull())
    .addColumn('subject', 'text', col => col.notNull())
    .addColumn('email', 'text')
    .addColumn('client_id', 'text')
    .addColumn('refresh_token_enc', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('user_identities_provider_subject_key', ['provider', 'subject'])
    .addUniqueConstraint('user_identities_user_provider_key', ['user_id', 'provider'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('user_identities').execute()
}
