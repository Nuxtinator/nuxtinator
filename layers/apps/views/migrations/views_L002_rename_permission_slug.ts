import { type Kysely, sql } from 'kysely'

// The app's permission moved from workflows.use to views.use with the layer
// rename. Default grants are code and follow on their own; this rewrites the
// places the slug is stored as data — custom roles, direct user grants and
// per-org role overrides (tenancy) — so existing roles keep their access.
// Tables owned by optional layers are skipped when absent.

async function tableExists(db: Kysely<unknown>, table: string): Promise<boolean> {
  const res = await sql<{ present: boolean }>`select to_regclass(${table}) is not null as present`.execute(db)
  return !!res.rows[0]?.present
}

async function renameSlug(db: Kysely<unknown>, from: string, to: string): Promise<void> {
  if (await tableExists(db, 'custom_roles')) {
    await sql`
      UPDATE custom_roles SET permissions = array_replace(permissions, ${from}::text, ${to}::text)
      WHERE ${from}::text = ANY(permissions)
    `.execute(db)
  }
  for (const table of ['user_permission_grants', 'org_role_overrides']) {
    if (!(await tableExists(db, table))) continue
    await sql`UPDATE ${sql.ref(table)} SET permission = ${to} WHERE permission = ${from}`.execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await renameSlug(db, 'workflows.use', 'views.use')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await renameSlug(db, 'views.use', 'workflows.use')
}
