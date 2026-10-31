import { type Kysely, sql } from 'kysely'

// Core's `groups.org_id` names the org a group belongs to (NULL for host
// groups). The foreign key can only exist once `orgs` does; deleting an org
// deletes its groups, and their memberships and app access with them.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE groups
      ADD CONSTRAINT groups_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE groups DROP CONSTRAINT groups_org_id_fkey`.execute(db)
}
