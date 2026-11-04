// files_create_site / files_update_site / files_read_site driven through the
// real /mcp transport with an issued bearer, in multi-tenant mode.
import { describe, it, expect, afterEach } from 'vitest'
import { fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupFilesTestData,
  createFilesOrgWith,
  createFilesUser,
  createTestDoc,
  createTestSite,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()

async function setupWriter(scopes: string[] = ['files.read', 'files.write']) {
  const { org, user } = await createFilesOrgWith(sql)
  const token = await issueMcpBearer(sql, user.id, scopes)
  return { org, user, token }
}

function sharePath(shareUrl: unknown): string {
  return new URL(shareUrl as string, 'http://x').pathname
}

describe('MCP files site tools', () => {
  afterEach(async () => { await cleanupFilesTestData(sql) })

  it('creates a site with an initial version and an audit row', async () => {
    const { org, user, token } = await setupWriter()
    const html = '<!doctype html><html><body><h1>MCP site</h1></body></html>'

    const result = await callMcpTool(token, 'files_create_site', {
      org: org.slug, title: '  Landing  ', html, tags: ['launch']
    })
    expect(result.isError, result.content[0]?.text).toBeFalsy()
    expect(result.structuredContent?.share_url).toBeNull()

    const id = result.structuredContent?.id as string
    const rows = await sql`SELECT kind, title, body_md, tags, share_token, org_id FROM files_items WHERE id = ${id}`
    expect(rows[0]).toMatchObject({ kind: 'site', title: 'Landing', body_md: html, tags: ['launch'], share_token: null, org_id: org.id })

    const versions = await sql`SELECT content FROM files_versions WHERE item_id = ${id}`
    expect(versions.map(v => v.content)).toEqual([html])

    const audit = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM activity_logs
      WHERE user_id = ${user.id} AND table_name = 'files_items' AND record_id = ${id}
    `
    expect(audit[0]!.metadata).toMatchObject({ source: 'mcp', tool: 'files_create_site', kind: 'site' })
  })

  it('share=true issues a public link that serves the HTML', async () => {
    const { org, token } = await setupWriter()
    const html = '<p>shared</p>'

    const result = await callMcpTool(token, 'files_create_site', { org: org.slug, title: 'Shared', html, share: true })
    const shareUrl = result.structuredContent?.share_url
    expect(shareUrl).toMatch(/\/files\/site\/[0-9a-f-]{36}$/)

    const res = await fetch(sharePath(shareUrl))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(html)
  })

  it('updates a site\'s HTML as a new version, live at its share link', async () => {
    const { org, token } = await setupWriter()
    const created = await callMcpTool(token, 'files_create_site', { org: org.slug, title: 'V', html: '<p>v1</p>', share: true })
    const id = created.structuredContent?.id as string

    const updated = await callMcpTool(token, 'files_update_site', { org: org.slug, id, html: '<p>v2</p>' })
    expect(updated.isError, updated.content[0]?.text).toBeFalsy()
    expect(updated.structuredContent?.share_url).toBe(created.structuredContent?.share_url)

    const versions = await sql`SELECT content FROM files_versions WHERE item_id = ${id} ORDER BY edited_at`
    expect(versions.map(v => v.content)).toEqual(['<p>v1</p>', '<p>v2</p>'])

    const res = await fetch(sharePath(updated.structuredContent?.share_url))
    expect(await res.text()).toBe('<p>v2</p>')

    const read = await callMcpTool(token, 'files_read_site', { org: org.slug, id })
    expect(read.structuredContent).toMatchObject({ id, title: 'V', html: '<p>v2</p>' })
  })

  it('a title-only update keeps the HTML', async () => {
    const { org, user, token } = await setupWriter()
    const { id } = await createTestSite(sql, { org_id: org.id, created_by: user.id, html: '<p>keep</p>' })

    await callMcpTool(token, 'files_update_site', { org: org.slug, id, title: 'Renamed' })
    const rows = await sql`SELECT title, body_md FROM files_items WHERE id = ${id}`
    expect(rows[0]).toMatchObject({ title: 'Renamed', body_md: '<p>keep</p>' })
  })

  it('site tools reject a doc, and doc tools reject a site', async () => {
    const { org, user, token } = await setupWriter()
    const doc = await createTestDoc(sql, { org_id: org.id, created_by: user.id })
    const site = await createTestSite(sql, { org_id: org.id, created_by: user.id })

    expect((await callMcpTool(token, 'files_update_site', { org: org.slug, id: doc.id, html: '<p>x</p>' })).isError).toBe(true)
    expect((await callMcpTool(token, 'files_update_doc', { org: org.slug, id: site.id, body_md: 'x' })).isError).toBe(true)
  })

  it('a read-only bearer cannot create a site', async () => {
    const { org, token } = await setupWriter(['files.read'])
    const result = await callMcpTool(token, 'files_create_site', { org: org.slug, title: 'Nope' })
    expect(result.isError).toBe(true)

    const rows = await sql`SELECT id FROM files_items WHERE org_id = ${org.id}`
    expect(rows).toHaveLength(0)
  })

  it('a non-member bearer cannot update a site in someone else\'s org', async () => {
    const { org, user } = await setupWriter()
    const { id } = await createTestSite(sql, { org_id: org.id, created_by: user.id, html: '<p>orig</p>' })
    const outsider = await createFilesUser(sql)
    const outsiderToken = await issueMcpBearer(sql, outsider.id, ['files.read', 'files.write'])

    const result = await callMcpTool(outsiderToken, 'files_update_site', { org: org.slug, id, html: '<p>pwned</p>' })
    expect(result.isError).toBe(true)
    const rows = await sql`SELECT body_md FROM files_items WHERE id = ${id}`
    expect(rows[0]!.body_md).toBe('<p>orig</p>')
  })
})
