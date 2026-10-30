// Share tables for personal apps: one per shareable resource, owned by the app
// layer, created from its migration with `createShareTable`. Imported by path
// (`@nuxtinator/core/share-tables`) because migrations load before Nuxt
// aliases exist.
//
// A share row names exactly one grantee: a user, or a pending invite that
// turns into that user when accepted. `role` is 'viewer' (read) or 'editor'
// (read, and add / change / delete rows inside the resource). Only the
// resource's owner shares, changes or removes shares; a grantee may remove
// their own. Register the table at boot with `registerShareTable` so known
// people and invite acceptance find it.
//
// The generated `security definer` functions let the share table's policies
// read the resource's owner, and other shares of the same resource, without
// running the resource table's own policies (which read the share table back;
// Postgres refuses that recursion).
import { sql, type Kysely } from 'kysely'

export interface ShareTableSpec {
  // The share table to create, e.g. 'familytree_tree_shares'.
  table: string
  // The resource it shares, e.g. 'familytree_trees'.
  resourceTable: string
  // The resource's primary key column (default 'id').
  resourceIdColumn?: string
  // The resource's owner column, a users.id (default 'owner_id').
  ownerColumn?: string
}

// The caller, as personal-app transactions set it.
export const CURRENT_USER_SQL = `nullif(current_setting('app.current_user', true), '')::uuid`

const IDENT_RE = /^[a-z][a-z0-9_]{0,40}$/

function names(spec: ShareTableSpec) {
  const resourceIdColumn = spec.resourceIdColumn ?? 'id'
  const ownerColumn = spec.ownerColumn ?? 'owner_id'
  for (const id of [spec.table, spec.resourceTable, resourceIdColumn, ownerColumn]) {
    if (!IDENT_RE.test(id)) throw new Error(`[share-tables] invalid identifier "${id}"`)
  }
  const t = spec.table
  return {
    t,
    rt: spec.resourceTable,
    rid: resourceIdColumn,
    owner: ownerColumn,
    ownerFn: `${t}_resource_owner`,
    memberFn: `${t}_has_member`,
    acceptFn: `${t}_accept_invite`
  }
}

// The SQL statements `createShareTable` runs, in order.
export function shareTableStatements(spec: ShareTableSpec): string[] {
  const { t, rt, rid, owner, ownerFn, memberFn, acceptFn } = names(spec)
  const me = CURRENT_USER_SQL
  return [
    `CREATE TABLE ${t} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      resource_id uuid NOT NULL REFERENCES ${rt}(${rid}) ON DELETE CASCADE,
      grantee_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      grantee_invite_id uuid REFERENCES invites(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('viewer', 'editor')),
      granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ${t}_one_grantee CHECK (num_nonnulls(grantee_user_id, grantee_invite_id) = 1)
    )`,
    `CREATE UNIQUE INDEX ${t}_resource_user_key ON ${t} (resource_id, grantee_user_id) WHERE grantee_user_id IS NOT NULL`,
    `CREATE UNIQUE INDEX ${t}_resource_invite_key ON ${t} (resource_id, grantee_invite_id) WHERE grantee_invite_id IS NOT NULL`,
    `CREATE INDEX ${t}_resource_idx ON ${t} (resource_id)`,
    `CREATE INDEX ${t}_user_idx ON ${t} (grantee_user_id)`,
    `CREATE INDEX ${t}_invite_idx ON ${t} (grantee_invite_id)`,

    `CREATE FUNCTION ${ownerFn}(p_resource uuid) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$ SELECT ${owner} FROM ${rt} WHERE ${rid} = p_resource $$`,
    `CREATE FUNCTION ${memberFn}(p_resource uuid, p_user uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$ SELECT EXISTS (SELECT 1 FROM ${t} WHERE resource_id = p_resource AND grantee_user_id = p_user) $$`,
    // Turns an accepted invite's pending shares into shares for p_user. Where
    // p_user already has a share of the same resource, the higher role wins
    // and the pending row goes; an owner accepting their own invite gains
    // nothing.
    `CREATE FUNCTION ${acceptFn}(p_invite uuid, p_user uuid) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
      BEGIN
        UPDATE ${t} d SET role = 'editor'
          FROM ${t} p
         WHERE p.grantee_invite_id = p_invite AND p.role = 'editor'
           AND d.resource_id = p.resource_id AND d.grantee_user_id = p_user;
        DELETE FROM ${t} p
         WHERE p.grantee_invite_id = p_invite
           AND (EXISTS (SELECT 1 FROM ${t} d WHERE d.resource_id = p.resource_id AND d.grantee_user_id = p_user)
                OR ${ownerFn}(p.resource_id) = p_user);
        UPDATE ${t} SET grantee_user_id = p_user, grantee_invite_id = NULL
         WHERE grantee_invite_id = p_invite;
      END
      $$`,

    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    // The owner sees every share; a grantee sees their own and the other
    // accepted shares of the same resource, never the pending ones.
    `CREATE POLICY ${t}_read ON ${t} FOR SELECT USING (
      ${ownerFn}(resource_id) = ${me}
      OR grantee_user_id = ${me}
      OR (grantee_user_id IS NOT NULL AND ${memberFn}(resource_id, ${me}))
    )`,
    `CREATE POLICY ${t}_insert ON ${t} FOR INSERT WITH CHECK (${ownerFn}(resource_id) = ${me})`,
    `CREATE POLICY ${t}_update ON ${t} FOR UPDATE
      USING (${ownerFn}(resource_id) = ${me})
      WITH CHECK (${ownerFn}(resource_id) = ${me})`,
    `CREATE POLICY ${t}_delete ON ${t} FOR DELETE USING (
      ${ownerFn}(resource_id) = ${me}
      OR grantee_user_id = ${me}
    )`
  ]
}

// Creates the share table, its functions and its policies. Call from the
// app's migration after the resource table exists.
export async function createShareTable(db: Kysely<any>, spec: ShareTableSpec): Promise<void> {
  for (const statement of shareTableStatements(spec)) {
    await sql.raw(statement).execute(db)
  }
}

// Drops what `createShareTable` made, for a migration's `down`, along with
// any policies that read the share table (the resource's `sharedWithMe`
// policies): restore the resource's own policies after it.
export async function dropShareTable(db: Kysely<any>, spec: ShareTableSpec): Promise<void> {
  const { t, ownerFn, memberFn, acceptFn } = names(spec)
  await sql.raw(`DROP TABLE IF EXISTS ${t} CASCADE`).execute(db)
  for (const fn of [`${acceptFn}(uuid, uuid)`, `${memberFn}(uuid, uuid)`, `${ownerFn}(uuid)`]) {
    await sql.raw(`DROP FUNCTION IF EXISTS ${fn}`).execute(db)
  }
}

// A policy condition for the resource table (or a child table, passing the
// expression that names the resource): true when a share names the caller.
// With `role: 'editor'`, only an editor share counts. Qualify the expression
// with its table name: a bare `id` would bind to the share table's own `id`.
//
//   CREATE POLICY familytree_trees_read ON familytree_trees FOR SELECT USING (
//     owner_id = ${CURRENT_USER_SQL}
//     OR ${sharedWithMe({ table: 'familytree_tree_shares' }, 'familytree_trees.id')}
//   )
export function sharedWithMe(spec: Pick<ShareTableSpec, 'table'>, resourceIdExpr: string, opts: { role?: 'editor' } = {}): string {
  if (!IDENT_RE.test(spec.table)) throw new Error(`[share-tables] invalid identifier "${spec.table}"`)
  const role = opts.role === 'editor' ? ` AND s.role = 'editor'` : ''
  return `EXISTS (SELECT 1 FROM ${spec.table} s WHERE s.resource_id = ${resourceIdExpr} AND s.grantee_user_id = ${CURRENT_USER_SQL}${role})`
}
