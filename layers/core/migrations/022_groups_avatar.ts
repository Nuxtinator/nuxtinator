import type { Kysely } from 'kysely'

// A group's avatar: an uploaded image, or an icon name (or short text). Both
// empty shows the group's initials.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('groups')
    .addColumn('icon', 'text')
    .addColumn('image', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('groups')
    .dropColumn('icon')
    .dropColumn('image')
    .execute()
}
