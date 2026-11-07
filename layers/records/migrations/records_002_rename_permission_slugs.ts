import { type Kysely, sql } from 'kysely'

// The record kernel's permission slugs moved from the crm namespace to the
// records layer's. Default grants are code and follow on their own; this
// rewrites every place a slug is stored as data: custom roles, direct user
// grants, per-org role overrides (tenancy), and the space-separated scope
// strings of every OAuth artifact (clients, pending requests, codes, tokens,
// consents), so existing roles and connected apps keep their access.
// Tables owned by optional layers are skipped when absent.

const SLUGS: Array<[string, string]> = [
  ['crm.records.read', 'records.entries.read'],
  ['crm.records.create', 'records.entries.create'],
  ['crm.records.update', 'records.entries.update'],
  ['crm.records.delete', 'records.entries.delete'],
  ['crm.records.share', 'records.entries.share'],
  ['crm.records.view_all', 'records.entries.view_all'],
  ['crm.schema.manage', 'records.schema.manage'],
  ['crm.read', 'records.read'],
  ['crm.write', 'records.write']
]

const SCOPE_COLUMNS: Array<[string, string]> = [
  ['oauth_clients', 'scope'],
  ['oauth_pending_requests', 'scope'],
  ['oauth_authorization_codes', 'scope'],
  ['oauth_access_tokens', 'scope'],
  ['oauth_refresh_tokens', 'scope'],
  ['oauth_consents', 'scope'],
  ['oauth_consents', 'declined_scope']
]

async function tableExists(db: Kysely<unknown>, table: string): Promise<boolean> {
  const res = await sql<{ present: boolean }>`select to_regclass(${table}) is not null as present`.execute(db)
  return !!res.rows[0]?.present
}

function mappingValues(pairs: Array<[string, string]>) {
  return sql.join(pairs.map(([from, to]) => sql`(${from}::text, ${to}::text)`))
}

async function renameSlugs(db: Kysely<unknown>, pairs: Array<[string, string]>): Promise<void> {
  if (await tableExists(db, 'custom_roles')) {
    for (const [from, to] of pairs) {
      await sql`
        UPDATE custom_roles SET permissions = array_replace(permissions, ${from}::text, ${to}::text)
        WHERE ${from}::text = ANY(permissions)
      `.execute(db)
    }
  }
  for (const table of ['user_permission_grants', 'org_role_overrides']) {
    if (!(await tableExists(db, table))) continue
    for (const [from, to] of pairs) {
      await sql`UPDATE ${sql.ref(table)} SET permission = ${to} WHERE permission = ${from}`.execute(db)
    }
  }
  for (const [table, column] of SCOPE_COLUMNS) {
    if (!(await tableExists(db, table))) continue
    await sql`
      UPDATE ${sql.ref(table)} AS t SET ${sql.ref(column)} = (
        SELECT string_agg(COALESCE(m.dst, s.tok), ' ' ORDER BY s.ord)
        FROM unnest(string_to_array(t.${sql.ref(column)}, ' ')) WITH ORDINALITY AS s(tok, ord)
        LEFT JOIN (VALUES ${mappingValues(pairs)}) AS m(src, dst) ON m.src = s.tok
      )
      WHERE string_to_array(t.${sql.ref(column)}, ' ') && ARRAY[${sql.join(pairs.map(([from]) => sql`${from}::text`))}]
    `.execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await renameSlugs(db, SLUGS)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await renameSlugs(db, SLUGS.map(([from, to]) => [to, from]))
}
