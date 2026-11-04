// update_section / bulk_update_sections driven through the real /mcp
// transport with an issued bearer, in multi-tenant mode. Covers the write
// path end to end (org resolution, section upsert, version row stamped
// `mcp`, audit row) and the atomicity contract: a call that returns an
// error has written nothing, for every section the call named.
import { describe, it, expect, afterEach } from 'vitest'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextUser,
  createContextOrg,
  addTestMembership,
  createTestPortfolio,
  seedTestSection,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()

// Org admin with a bearer carrying both context scopes. The user holds no
// host-level role; every permission comes from the org membership.
async function setupWriter() {
  const user = await createContextUser(sql)
  const org = await createContextOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })
  const portfolio = await createTestPortfolio(sql, { org_id: org.id, name: 'MCP Writes', created_by: user.id })
  const token = await issueMcpBearer(sql, user.id, ['context.read', 'context.write'])
  return { user, org, portfolio, token }
}

async function sectionRow(portfolioId: string, key: string) {
  const rows = await sql<{ id: string, content: string, last_edited_at: Date }[]>`
    SELECT id, content, last_edited_at FROM context_sections
    WHERE portfolio_id = ${portfolioId} AND section_key = ${key}
  `
  return rows[0] ?? null
}

const OVERSIZED = 'x'.repeat(100 * 1024 + 1)

describe('MCP update_section / bulk_update_sections', () => {
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-context-%'`
  })

  it('update_section writes the section, a version stamped mcp, and an audit row', async () => {
    const { user, org, portfolio, token } = await setupWriter()

    const result = await callMcpTool(token, 'update_section', {
      org: org.slug,
      portfolio_id: portfolio.id,
      section_key: 'identity',
      content: 'We are Acme — est. 2001.'
    })
    expect(result.isError, result.content[0]?.text).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ key: 'identity', status: 'updated' })
    expect(result.structuredContent?.version_id).toBeDefined()

    const row = await sectionRow(portfolio.id, 'identity')
    expect(row?.content).toBe('We are Acme — est. 2001.')

    const versions = await sql<{ id: string, source: string | null }[]>`
      SELECT id, source FROM context_section_versions WHERE section_id = ${row!.id}
    `
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ id: result.structuredContent?.version_id, source: 'mcp' })

    const audit = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM activity_logs
      WHERE user_id = ${user.id} AND table_name = 'context_sections' AND record_id = ${row!.id}
    `
    expect(audit).toHaveLength(1)
    expect(audit[0]!.metadata).toMatchObject({ source: 'mcp', tool: 'update_section', key: 'identity' })
  })

  it('update_section with a stale last_edited_at reports a conflict and changes nothing', async () => {
    const { user, org, portfolio, token } = await setupWriter()
    await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'team', content: 'current', last_edited_by: user.id })
    const before = await sectionRow(portfolio.id, 'team')

    const result = await callMcpTool(token, 'update_section', {
      org: org.slug,
      portfolio_id: portfolio.id,
      section_key: 'team',
      content: 'overwrite',
      last_edited_at: '2020-01-01T00:00:00.000Z'
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ key: 'team', status: 'conflict' })

    const after = await sectionRow(portfolio.id, 'team')
    expect(after?.content).toBe('current')
    expect(after?.last_edited_at.toISOString()).toBe(before!.last_edited_at.toISOString())
  })

  it('a failed update_section on a never-written section creates no row', async () => {
    const { org, portfolio, token } = await setupWriter()

    const result = await callMcpTool(token, 'update_section', {
      org: org.slug,
      portfolio_id: portfolio.id,
      section_key: 'team',
      content: OVERSIZED
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('100KB')

    expect(await sectionRow(portfolio.id, 'team')).toBeNull()
  })

  it('bulk_update_sections rolls back every update when a later one fails', async () => {
    const { user, org, portfolio, token } = await setupWriter()
    await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'identity', content: 'before', last_edited_by: user.id })
    const before = await sectionRow(portfolio.id, 'identity')

    const result = await callMcpTool(token, 'bulk_update_sections', {
      org: org.slug,
      portfolio_id: portfolio.id,
      updates: [
        { section_key: 'identity', content: 'after' },
        { section_key: 'team', content: OVERSIZED }
      ]
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('100KB')

    const identity = await sectionRow(portfolio.id, 'identity')
    expect(identity?.content).toBe('before')
    expect(identity?.last_edited_at.toISOString()).toBe(before!.last_edited_at.toISOString())
    expect(await sectionRow(portfolio.id, 'team')).toBeNull()

    const versions = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM context_section_versions WHERE section_id = ${before!.id}
    `
    expect(versions[0]!.count).toBe('0')
  })
})
