import { type Kysely, sql } from 'kysely'

// A project is visible to the whole org (`org`) or only to the teams listed in
// `feedback_project_teams` (`teams`). Team restriction is enforced by core's
// team-access helper, not RLS.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('visibility', 'text', col => col.notNull().defaultTo('org'))
    .execute()
  await sql`
    ALTER TABLE projects
      ADD CONSTRAINT projects_visibility_check CHECK (visibility IN ('org', 'teams'))
  `.execute(db)

  await db.schema
    .createTable('feedback_project_teams')
    .addColumn('container_id', 'uuid', col => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('group_id', 'uuid', col => col.notNull().references('groups.id').onDelete('restrict'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('feedback_project_teams_pkey', ['container_id', 'group_id'])
    .execute()

  await db.schema
    .createIndex('feedback_project_teams_group_idx')
    .on('feedback_project_teams')
    .column('group_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('feedback_project_teams').execute()
  await sql`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_visibility_check`.execute(db)
  await db.schema.alterTable('projects').dropColumn('visibility').execute()
}
