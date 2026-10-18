// Every org-scoped permission check assumes each row visible inside a tenant
// transaction belongs to the active org. These assertions hold every layer's
// migrations to that: RLS on every org_id table, and every policy is exactly
// "org_id = active org". Reaching rows of another org goes through
// `withRecordOrgContext`, never a wider policy. The one other shape allowed is
// a personal-app policy: on a table with no org_id, keyed on the
// `app.current_user` setting (see core's personal-apps.ts). Each top-level OR
// branch of it must test a session setting, so a branch like `true` can't
// widen it to every row.
import { describe, it, expect } from 'vitest'
import { getHostAdminDb, getAppUserDb } from '../helpers'

const ACTIVE_ORG = `(org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)`
const CURRENT_USER = `current_setting('app.current_user'::text, true)`
const ANY_SETTING = `current_setting('app.`

// The top-level OR branches of a deparsed policy expression.
function orBranches(expr: string): string[] {
  let e = expr.trim()
  const wrapsWhole = (s: string) => {
    if (!s.startsWith('(') || !s.endsWith(')')) return false
    let depth = 0
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') depth--
      if (depth === 0 && i < s.length - 1) return false
    }
    return true
  }
  while (wrapsWhole(e)) e = e.slice(1, -1).trim()
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(') depth++
    else if (e[i] === ')') depth--
    else if (depth === 0 && e.startsWith(' OR ', i)) {
      out.push(e.slice(start, i))
      start = i + 4
    }
  }
  out.push(e.slice(start))
  return out
}

const keyedOnUser = (expr: string) =>
  expr.includes(CURRENT_USER) && orBranches(expr).every(b => b.includes(ANY_SETTING))

// org_id tables read outside any org context, filtered by org_id in code.
const NO_RLS = new Set([
  'memberships', // resolves the active org itself
  'org_apps', // app switch checks run before and outside the org transaction
  'invite_orgs', // invite acceptance runs before membership exists
  'activity_logs' // nullable org_id; host-wide events and the rate limiter read it without an org
])

describe('RLS policy invariant', () => {
  const sql = getHostAdminDb()

  it('every policy restricts rows to the active org', async () => {
    const policies = await sql<{ tablename: string, policyname: string, qual: string | null, with_check: string | null }[]>`
      select tablename, policyname, qual, with_check
      from pg_policies
      where schemaname = 'public'
    `
    expect(policies.length).toBeGreaterThan(0)
    const orgTables = new Set((await sql<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
      where n.nspname = 'public'
    `).map(t => t.relname))
    const orgScoped = (p: typeof policies[number]) =>
      p.qual === ACTIVE_ORG && (p.with_check === null || p.with_check === ACTIVE_ORG)
    const userScoped = (p: typeof policies[number]) =>
      !orgTables.has(p.tablename)
      && (p.qual !== null || p.with_check !== null)
      && (p.qual === null || keyedOnUser(p.qual))
      && (p.with_check === null || keyedOnUser(p.with_check))
    const wider = policies
      .filter(p => !orgScoped(p) && !userScoped(p))
      .map(p => `${p.tablename}.${p.policyname}: USING ${p.qual} WITH CHECK ${p.with_check}`)
    expect(wider).toEqual([])
  })

  it('every table with a policy has row-level security', async () => {
    const tables = await sql<{ relname: string }[]>`
      select distinct c.relname
      from pg_policies p
      join pg_class c on c.relname = p.tablename
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
      where p.schemaname = 'public' and not c.relrowsecurity
    `
    expect(tables.map(t => t.relname)).toEqual([])
  })

  it('every table with an org_id column has row-level security', async () => {
    const tables = await sql<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    `
    const unprotected = tables.map(t => t.relname).filter(name => !NO_RLS.has(name))
    expect(unprotected).toEqual([])
  })

  it('the app role is subject to RLS', async () => {
    const app = getAppUserDb()
    const [role] = await app<{ rolsuper: boolean, rolbypassrls: boolean, owned: number }[]>`
      select rolsuper, rolbypassrls,
        (select count(*)::int from pg_class c where c.relrowsecurity and c.relowner = r.oid) as owned
      from pg_roles r where rolname = current_user
    `
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 })
  })
})
