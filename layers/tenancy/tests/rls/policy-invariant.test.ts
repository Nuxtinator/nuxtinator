// Every org-scoped permission check assumes each row visible inside a tenant
// transaction belongs to the active org. These assertions hold every layer's
// migrations to that: RLS on every org_id table, and every policy is exactly
// "org_id = active org". Reaching rows of another org goes through
// `withRecordOrgContext`, never a wider policy.
import { describe, it, expect } from 'vitest'
import { getHostAdminDb, getAppUserDb } from '../helpers'

const ACTIVE_ORG = `(org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)`

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
    const wider = policies
      .filter(p => p.qual !== ACTIVE_ORG || (p.with_check !== null && p.with_check !== ACTIVE_ORG))
      .map(p => `${p.tablename}.${p.policyname}: USING ${p.qual} WITH CHECK ${p.with_check}`)
    expect(wider).toEqual([])
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
