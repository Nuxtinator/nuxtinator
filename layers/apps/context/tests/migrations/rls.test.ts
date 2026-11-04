// Multi-tenant: tenancy retrofit migration adds org_id + RLS to
// context_portfolios. This test runs against the booted Nuxt server, which
// loads the tenancy layer, so both `_T<NNN>_` per-app retrofits and the
// `current_org_id()` function should be in place.
import { describe, it, expect } from 'vitest'
import { getHostAdminDb } from '../helpers'

describe('rls (multi-tenant test mode)', () => {
  const sql = getHostAdminDb()

  it('context_portfolios has an org_id column', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'context_portfolios'
    `
    const names = rows.map(r => r.column_name)
    expect(names).toContain('org_id')
  })

  it('row level security is enabled on context_portfolios', async () => {
    const rows = await sql<{ relrowsecurity: boolean }[]>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'context_portfolios'
    `
    expect(rows[0]?.relrowsecurity).toBe(true)
  })

  it('the tenant_isolation policy exists on context_portfolios', async () => {
    const rows = await sql<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE tablename = 'context_portfolios'
    `
    expect(rows.some(r => r.policyname === 'tenant_isolation')).toBe(true)
  })

  it('context_assistant_conversations is tenant-scoped directly', async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'context_assistant_conversations'
    `
    expect(cols.map(r => r.column_name)).toContain('org_id')
    const policies = await sql<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE tablename = 'context_assistant_conversations'
    `
    expect(policies.some(r => r.policyname === 'tenant_isolation')).toBe(true)
  })
})

describe('rls — section chunks', () => {
  const sql = getHostAdminDb()

  it('context_section_chunks is tenant-scoped with the vector column present', async () => {
    const cols = await sql<{ column_name: string, udt_name: string }[]>`
      SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_name = 'context_section_chunks'
    `
    const names = cols.map(r => r.column_name)
    expect(names).toContain('org_id')
    expect(cols.find(r => r.column_name === 'embedding')?.udt_name).toBe('vector')
    const policies = await sql<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE tablename = 'context_section_chunks'
    `
    expect(policies.some(r => r.policyname === 'tenant_isolation')).toBe(true)
  })
})
