import { sql } from 'kysely'
import { db } from '#core/server/utils/database'

// Tenant isolation holds only if `db` connects as a role RLS applies to.
// Superusers, BYPASSRLS roles, and owners of RLS tables (without FORCE ROW
// LEVEL SECURITY) see every org's rows, which turns every org-scoped
// permission check into a check against rows from any org.

let verdict: Promise<string | null> | null = null

// Null when `db`'s role is RLS-enforced, else why it isn't. Cached per
// process; a failed lookup isn't cached so the next call retries.
export function rlsBypassReason(): Promise<string | null> {
  verdict ??= checkRole().catch((err) => {
    verdict = null
    throw err
  })
  return verdict
}

async function checkRole(): Promise<string | null> {
  const { rows: [role] } = await sql<{ name: string, rolsuper: boolean, rolbypassrls: boolean }>`
    select rolname as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user
  `.execute(db)
  if (!role) return null
  if (role.rolsuper) return `role "${role.name}" is a superuser`
  if (role.rolbypassrls) return `role "${role.name}" has BYPASSRLS`

  const { rows: owned } = await sql<{ relname: string }>`
    select c.relname from pg_class c
    where c.relrowsecurity and not c.relforcerowsecurity
      and c.relowner = (select oid from pg_roles where rolname = current_user)
    order by c.relname
    limit 5
  `.execute(db)
  if (owned.length) {
    return `role "${role.name}" owns RLS tables (${owned.map(r => r.relname).join(', ')}) and table owners bypass RLS`
  }
  return null
}

export function rlsBypassMessage(reason: string): string {
  return `Tenant isolation is not enforced: the app database connection's ${reason}. `
    + 'Set APP_DATABASE_URL to a role without BYPASSRLS that owns no tables (app_user — see documentation/tenancy.md).'
}

// Fails the request closed when isolation isn't enforced. An unreachable
// database is left to the handler, since no rows can leak without one.
export async function assertDbEnforcesRls(): Promise<void> {
  let reason: string | null
  try {
    reason = await rlsBypassReason()
  } catch {
    return
  }
  if (reason) {
    console.error(`[tenancy] ${rlsBypassMessage(reason)}`)
    throw createError({ statusCode: 503, statusMessage: 'Tenant isolation is not configured' })
  }
}
