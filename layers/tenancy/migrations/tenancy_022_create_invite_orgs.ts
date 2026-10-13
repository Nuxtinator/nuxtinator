import { type Kysely, sql } from 'kysely'

// The orgs (and roles in each) an invite grants on acceptance. Not RLS-scoped,
// like `memberships`: endpoints authorize in application code, and acceptance
// runs before the invitee has any org context.
//
// Placeholder invite users converted by core's `013_move_pending_invites` keep
// their user id as the invite id, so their memberships are copied across here
// and the placeholders are then deleted.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('invite_orgs')
    .addColumn('invite_id', 'uuid', col => col.notNull().references('invites.id').onDelete('cascade'))
    .addColumn('org_id', 'uuid', col => col.notNull().references('orgs.id').onDelete('cascade'))
    .addColumn('roles', sql`text[]`, col => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addPrimaryKeyConstraint('invite_orgs_pkey', ['invite_id', 'org_id'])
    .execute()

  await db.schema.createIndex('invite_orgs_org_idx').on('invite_orgs').column('org_id').execute()

  await sql`
    INSERT INTO invite_orgs (invite_id, org_id, roles)
    SELECT m.user_id, m.org_id, m.roles
      FROM memberships m
      JOIN invites i ON i.id = m.user_id
      JOIN users u ON u.id = m.user_id
     WHERE u.password IS NULL AND u.verified = false
  `.execute(db)

  await sql`
    DELETE FROM users u
     USING invites i
     WHERE u.id = i.id AND u.password IS NULL AND u.verified = false
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('invite_orgs').execute()
}
