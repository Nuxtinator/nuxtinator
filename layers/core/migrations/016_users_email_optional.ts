import { type Kysely, sql } from 'kysely'

// A user can exist without an email address: a host app may create accounts
// for people who identify some other way (an app install, a device) and add
// an address later. Such a user can't sign in through any email-based method
// until an address is set. The unique constraint still holds for addresses
// that are present.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`.execute(db)
}

// Fails while any user has no address, rather than deleting those accounts.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE users ALTER COLUMN email SET NOT NULL`.execute(db)
}
