// files_begin_upload / files_complete_upload / files_share / files_unshare
// driven through the real /mcp transport, in multi-tenant mode. Tests that
// PUT or HEAD real objects skip when no S3 bucket is configured.
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { fetch } from '@nuxt/test-utils/e2e'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import {
  getHostAdminDb,
  cleanupFilesTestData,
  createFilesOrgWith,
  createTestFile,
  createTestSite,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()
const SKIP_S3 = !process.env.S3_BUCKET_NAME || !process.env.S3_ENDPOINT

const uploadedKeys: string[] = []

function s3(): S3Client {
  return new S3Client({
    endPoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION || 'us-west-004',
    bucket: process.env.S3_BUCKET_NAME!,
    accessKey: process.env.S3_ACCESS_KEY_ID!,
    secretKey: process.env.S3_SECRET_ACCESS_KEY!,
    pathStyle: true
  })
}

async function setupWriter() {
  const { org, user } = await createFilesOrgWith(sql)
  const token = await issueMcpBearer(sql, user.id, ['files.read', 'files.write'])
  return { org, user, token }
}

function path(url: unknown): string {
  return new URL(url as string, 'http://x').pathname
}

describe('MCP files upload + share tools', () => {
  afterEach(async () => {
    await cleanupFilesTestData(sql)
    while (uploadedKeys.length) await s3().deleteObject(uploadedKeys.pop()!)
  })

  it('begin_upload rejects files over 50 MB', async () => {
    const { org, token } = await setupWriter()
    const result = await callMcpTool(token, 'files_begin_upload', {
      org: org.slug, filename: 'big.mp4', mime: 'video/mp4', size_bytes: 50 * 1024 * 1024 + 1
    })
    expect(result.isError).toBe(true)
  })

  it('begin_upload returns a PUT URL and an org-prefixed key', async () => {
    const { org, token } = await setupWriter()
    const result = await callMcpTool(token, 'files_begin_upload', {
      org: org.slug, filename: 'demo.MP4', mime: 'video/mp4', size_bytes: 1000
    })
    expect(result.isError, result.content[0]?.text).toBeFalsy()
    const out = result.structuredContent!
    expect(out.key).toMatch(new RegExp(`^files/${org.id}/[0-9a-f-]{36}\\.mp4$`))
    expect(out.method).toBe('PUT')
    expect(out.headers).toEqual({ 'Content-Type': 'video/mp4' })
    expect(out.upload_url).toContain(out.key as string)
  })

  it('complete_upload rejects a key from another org\'s prefix', async () => {
    const { org, token } = await setupWriter()
    const other = await createFilesOrgWith(sql)
    const result = await callMcpTool(token, 'files_complete_upload', {
      org: org.slug, key: `files/${other.org.id}/${randomUUID()}.mp4`, filename: 'x.mp4'
    })
    expect(result.isError).toBe(true)
  })

  it('complete_upload rejects a key already used by an item', async () => {
    const { org, user, token } = await setupWriter()
    const key = `files/${org.id}/${randomUUID()}.mp4`
    const { id } = await createTestFile(sql, { org_id: org.id, created_by: user.id })
    await sql`UPDATE files_items SET storage_key = ${key} WHERE id = ${id}`

    const result = await callMcpTool(token, 'files_complete_upload', { org: org.slug, key, filename: 'x.mp4' })
    expect(result.isError).toBe(true)
    const rows = await sql`SELECT id FROM files_items WHERE storage_key = ${key}`
    expect(rows).toHaveLength(1)
  })

  it.skipIf(SKIP_S3)('complete_upload rejects a key with no uploaded object', async () => {
    const { org, token } = await setupWriter()
    const result = await callMcpTool(token, 'files_complete_upload', {
      org: org.slug, key: `files/${org.id}/${randomUUID()}.mp4`, filename: 'x.mp4'
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('No uploaded object')
  })

  it.skipIf(SKIP_S3)('uploads via the presigned URL, completes with share, and serves the raw URL', async () => {
    const { org, user, token } = await setupWriter()
    const bytes = new TextEncoder().encode('fake mp4 bytes')
    const begun = await callMcpTool(token, 'files_begin_upload', {
      org: org.slug, filename: 'demo.mp4', mime: 'video/mp4', size_bytes: bytes.byteLength
    })
    const { upload_url: uploadUrl, key } = begun.structuredContent as { upload_url: string, key: string }
    uploadedKeys.push(key)

    const put = await globalThis.fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: bytes })
    expect(put.status).toBe(200)

    const done = await callMcpTool(token, 'files_complete_upload', {
      org: org.slug, key, filename: 'demo.mp4', title: 'Demo', share: true
    })
    expect(done.isError, done.content[0]?.text).toBeFalsy()
    const out = done.structuredContent as { id: string, share_url: string, raw_url: string }
    expect(out.share_url).toMatch(/\/files\/public\/[0-9a-f-]{36}$/)
    expect(out.raw_url).toMatch(/\/files\/raw\/[0-9a-f-]{36}$/)

    const rows = await sql`SELECT kind, title, filename, mime, size_bytes, org_id, created_by FROM files_items WHERE id = ${out.id}`
    expect(rows[0]).toMatchObject({
      kind: 'file', title: 'Demo', filename: 'demo.mp4', mime: 'video/mp4',
      size_bytes: String(bytes.byteLength), org_id: org.id, created_by: user.id
    })

    const raw = await fetch(path(out.raw_url), { redirect: 'manual' })
    expect(raw.status).toBe(302)
    const served = await globalThis.fetch(raw.headers.get('location')!)
    expect(await served.text()).toBe('fake mp4 bytes')
  })

  it('files_share returns the existing link unless reissue is set', async () => {
    const { org, user, token } = await setupWriter()
    const { id } = await createTestFile(sql, { org_id: org.id, created_by: user.id })

    const first = await callMcpTool(token, 'files_share', { org: org.slug, id })
    expect(first.isError, first.content[0]?.text).toBeFalsy()
    expect(first.structuredContent?.raw_url).toMatch(/\/files\/raw\/[0-9a-f-]{36}$/)

    const again = await callMcpTool(token, 'files_share', { org: org.slug, id })
    expect(again.structuredContent).toEqual(first.structuredContent)

    const reissued = await callMcpTool(token, 'files_share', { org: org.slug, id, reissue: true })
    expect(reissued.structuredContent?.raw_url).not.toBe(first.structuredContent?.raw_url)
    expect((await fetch(path(first.structuredContent?.raw_url), { redirect: 'manual' })).status).toBe(404)
  })

  it('files_share gives a site its raw site URL and no raw_url', async () => {
    const { org, user, token } = await setupWriter()
    const { id } = await createTestSite(sql, { org_id: org.id, created_by: user.id })
    const result = await callMcpTool(token, 'files_share', { org: org.slug, id })
    expect(result.structuredContent?.share_url).toMatch(/\/files\/site\/[0-9a-f-]{36}$/)
    expect(result.structuredContent?.raw_url).toBeNull()
  })

  it('files_unshare makes the raw URL 404 and files_list reports the links', async () => {
    const { org, user, token } = await setupWriter()
    const { id } = await createTestFile(sql, { org_id: org.id, created_by: user.id })
    const shared = await callMcpTool(token, 'files_share', { org: org.slug, id })
    const rawUrl = shared.structuredContent?.raw_url

    const listed = await callMcpTool(token, 'files_list', { org: org.slug })
    const items = listed.structuredContent?.items as Array<{ id: string, raw_url: string | null, share_url: string | null }>
    expect(items.find(i => i.id === id)).toMatchObject({ raw_url: rawUrl, share_url: shared.structuredContent?.share_url })

    const unshared = await callMcpTool(token, 'files_unshare', { org: org.slug, id })
    expect(unshared.structuredContent).toEqual({ ok: true })
    expect((await fetch(path(rawUrl), { redirect: 'manual' })).status).toBe(404)

    const relisted = await callMcpTool(token, 'files_list', { org: org.slug })
    const after = (relisted.structuredContent?.items as typeof items).find(i => i.id === id)
    expect(after).toMatchObject({ raw_url: null, share_url: null })
  })
})
