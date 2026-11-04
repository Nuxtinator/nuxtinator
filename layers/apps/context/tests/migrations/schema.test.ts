// Migrations create the context tables with the expected columns.
// Runs against the booted Nuxt server's DB (which ran every migration via
// the core layer's Nitro migrations plugin).
import { describe, it, expect } from 'vitest'
import { getHostAdminDb } from '../helpers'

const TABLES = [
  'context_portfolios',
  'context_sections',
  'context_section_versions',
  'context_section_definitions',
  'context_section_comments',
  'context_section_comment_replies',
  'context_assistant_conversations',
  'context_assistant_messages'
] as const

describe('schema migrations', () => {
  const sql = getHostAdminDb()

  it.each(TABLES)('creates table %s', async (tbl) => {
    const rows = await sql<{ exists: boolean }[]>`SELECT to_regclass(${tbl}) IS NOT NULL AS exists`
    expect(rows[0]?.exists).toBe(true)
  })

  it('context_portfolios has the expected columns', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'context_portfolios'
    `
    const names = rows.map(r => r.column_name)
    expect(names).toContain('slug')
    expect(names).toContain('name')
    expect(names).toContain('color')
    expect(names).toContain('icon_url')
  })

  it('context_section_definitions stores built-in rows without a title', async () => {
    const rows = await sql<{ column_name: string, is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'context_section_definitions'
    `
    const byName = new Map(rows.map(r => [r.column_name, r.is_nullable]))
    expect(byName.get('key')).toBe('NO')
    expect(byName.get('title')).toBe('YES')
    expect(byName.get('created_by')).toBe('YES')
    expect(byName.get('is_custom')).toBe('NO')
  })

  it('context_section_versions has a source column', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'context_section_versions'
    `
    const names = rows.map(r => r.column_name)
    expect(names).toContain('source')
  })

  it('context_section_comments has anchor columns', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'context_section_comments'
    `
    const names = rows.map(r => r.column_name)
    expect(names).toContain('anchor_start')
    expect(names).toContain('anchor_end')
    expect(names).toContain('anchor_hash')
    expect(names).toContain('quoted_text')
  })
})
