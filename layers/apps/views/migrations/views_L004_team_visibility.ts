import { type Kysely, sql } from 'kysely'

// A view opens to everyone in the org (`org`), to the teams listed in
// `views_teams` (`teams`), or only to its owner (`private`); people it is
// shared with reach it whatever its visibility. Team restriction is enforced
// by the views access checks, not RLS.
//
// `shared` views become `private` (their shares keep working). Shares on
// views that were `private` granted nothing, so they are removed rather than
// opened up.

async function visibilityChecks(db: Kysely<unknown>): Promise<string[]> {
  const res = await sql<{ conname: string }>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'views_definitions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%visibility%'
  `.execute(db)
  return res.rows.map(r => r.conname)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM views_shares s USING views_definitions v
    WHERE v.id = s.view_id AND v.visibility = 'private'
  `.execute(db)

  for (const name of await visibilityChecks(db)) {
    await sql`ALTER TABLE views_definitions DROP CONSTRAINT ${sql.ref(name)}`.execute(db)
  }
  await sql`UPDATE views_definitions SET visibility = 'private' WHERE visibility = 'shared'`.execute(db)
  await sql`
    ALTER TABLE views_definitions
      ADD CONSTRAINT views_definitions_visibility_check CHECK (visibility IN ('private', 'org', 'teams'))
  `.execute(db)

  await db.schema
    .createTable('views_teams')
    .addColumn('container_id', 'uuid', col => col.notNull().references('views_definitions.id').onDelete('cascade'))
    .addColumn('group_id', 'uuid', col => col.notNull().references('groups.id').onDelete('restrict'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('views_teams_pkey', ['container_id', 'group_id'])
    .execute()

  await db.schema
    .createIndex('views_teams_group_idx')
    .on('views_teams')
    .column('group_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('views_teams').execute()
  await sql`UPDATE views_definitions SET visibility = 'private' WHERE visibility = 'teams'`.execute(db)
  await sql`ALTER TABLE views_definitions DROP CONSTRAINT IF EXISTS views_definitions_visibility_check`.execute(db)
  await sql`
    ALTER TABLE views_definitions
      ADD CONSTRAINT views_definitions_visibility_check CHECK (visibility IN ('private', 'shared', 'org'))
  `.execute(db)
}
