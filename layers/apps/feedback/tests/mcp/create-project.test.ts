// feedback_create_project driven through the real /mcp transport with an
// issued bearer, in multi-tenant mode. Covers the create path end to end
// (org resolution from the `org` input, board + default swimlane rows, audit
// row) and the scope gate that keeps a read-only bearer out.
import { describe, it, expect, afterEach } from 'vitest'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackUser,
  createFeedbackOrg,
  addTestMembership,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()

// Org admin with a bearer carrying both feedback scopes. The user holds no
// host-level role; every permission comes from the org membership.
async function setupWriter(scopes: string[] = ['feedback.read', 'feedback.write']) {
  const user = await createFeedbackUser(sql)
  const org = await createFeedbackOrg(sql)
  await addTestMembership(sql, { user_id: user.id, org_id: org.id, roles: ['admin'] })
  const token = await issueMcpBearer(sql, user.id, scopes)
  return { user, org, token }
}

async function projectRow(id: string) {
  const rows = await sql<{
    id: string
    name: string
    description: string | null
    post_meta: Record<string, unknown>
    org_id: string
  }[]>`
    SELECT id, name, description, post_meta, org_id FROM projects WHERE id = ${id}
  `
  return rows[0] ?? null
}

describe('MCP feedback_create_project', () => {
  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  it('creates the board, its default swimlane, and an audit row', async () => {
    const { user, org, token } = await setupWriter()

    const result = await callMcpTool(token, 'feedback_create_project', {
      org: org.slug,
      name: 'Acme Roadmap',
      description: 'Public-facing intake',
      post_meta: { repo: 'acme/web' }
    })
    expect(result.isError, result.content[0]?.text).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ name: 'Acme Roadmap' })

    const id = result.structuredContent?.id as string
    const row = await projectRow(id)
    expect(row).toMatchObject({
      name: 'Acme Roadmap',
      description: 'Public-facing intake',
      org_id: org.id
    })
    expect(row?.post_meta).toMatchObject({ repo: 'acme/web' })

    const lanes = await sql<{ id: string, name: string, is_default: boolean, org_id: string }[]>`
      SELECT id, name, is_default, org_id FROM swimlanes WHERE project_id = ${id}
    `
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({
      id: result.structuredContent?.swimlane_id,
      name: 'default',
      is_default: true,
      org_id: org.id
    })

    const audit = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM activity_logs
      WHERE user_id = ${user.id} AND table_name = 'projects' AND record_id = ${id}
    `
    expect(audit).toHaveLength(1)
    expect(audit[0]!.metadata).toMatchObject({
      source: 'mcp',
      tool: 'feedback_create_project',
      name: 'Acme Roadmap'
    })
  })

  it('the new board accepts a card and shows up in feedback_list_projects', async () => {
    const { org, token } = await setupWriter()

    const created = await callMcpTool(token, 'feedback_create_project', {
      org: org.slug,
      name: 'Fresh Board'
    })
    const id = created.structuredContent?.id as string

    const card = await callMcpTool(token, 'feedback_create_card', {
      org: org.slug,
      project_id: id,
      title: 'First finding'
    })
    expect(card.isError, card.content[0]?.text).toBeFalsy()
    expect(card.structuredContent).toMatchObject({ column: 'FEEDBACK INBOX' })

    const list = await callMcpTool(token, 'feedback_list_projects', { org: org.slug })
    const projects = list.structuredContent?.projects as Array<{ id: string, name: string }>
    expect(projects.map(p => p.id)).toContain(id)
  })

  it('omitting description and post_meta leaves them null / empty', async () => {
    const { org, token } = await setupWriter()

    const result = await callMcpTool(token, 'feedback_create_project', {
      org: org.slug,
      name: '  Padded Name  '
    })
    const row = await projectRow(result.structuredContent?.id as string)
    expect(row?.name).toBe('Padded Name')
    expect(row?.description).toBeNull()
    expect(row?.post_meta).toEqual({})
  })

  it('a read-only bearer cannot create a board and writes nothing', async () => {
    const { org, token } = await setupWriter(['feedback.read'])

    const result = await callMcpTool(token, 'feedback_create_project', {
      org: org.slug,
      name: 'Should Not Exist'
    })
    expect(result.isError).toBe(true)

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM projects WHERE org_id = ${org.id}
    `
    expect(rows).toHaveLength(0)
  })

  it('a non-member bearer cannot create a board in someone else\'s org', async () => {
    const { org } = await setupWriter()
    const outsider = await createFeedbackUser(sql)
    const outsiderToken = await issueMcpBearer(sql, outsider.id, ['feedback.read', 'feedback.write'])

    const result = await callMcpTool(outsiderToken, 'feedback_create_project', {
      org: org.slug,
      name: 'Trespass'
    })
    expect(result.isError).toBe(true)

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM projects WHERE org_id = ${org.id}
    `
    expect(rows).toHaveLength(0)
  })
})
