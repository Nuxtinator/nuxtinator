// records_begin_attachment_upload / records_complete_attachment_upload over
// the real /mcp transport. Tests that PUT or read real objects skip when no S3
// bucket is configured.
import { randomBytes } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  issueMcpBearer,
  callMcpTool,
  RECORDS_TEST_MCP_CLIENT_NAME,
  type McpToolResult
} from '../helpers'

const sql = getHostAdminDb()
const SKIP_S3 = !process.env.S3_BUCKET_NAME || !process.env.S3_ENDPOINT
const TYPE = 'test_records_photos'

const storedKeys: string[] = []

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

afterEach(async () => {
  await cleanupRecordsTestData(sql)
  while (storedKeys.length) {
    const key = storedKeys.pop()!
    await s3().deleteObject(key)
    await sql`DELETE FROM records_attachment_trash WHERE storage_key = ${key}`
  }
})

function ok(res: McpToolResult): Record<string, unknown> {
  expect(res.isError, res.content.map(c => c.text).join('\n')).toBeFalsy()
  return res.structuredContent!
}

function errorText(res: McpToolResult): string {
  expect(res.isError).toBe(true)
  return res.content.map(c => c.text).join('\n')
}

// An org with a type that has a `photos` attachments field and one record on it.
async function setup() {
  const { org, user } = await createRecordsOrgWith(sql, ['admin'])
  const { token } = await issueMcpBearer(sql, user.id, ['records.read', 'records.write', 'records.schema.manage'])
  ok(await callMcpTool(token, 'records_create_type', {
    org: org.slug,
    key: TYPE,
    label: 'Photos',
    labelSingular: 'Photo',
    fields: [{ key: 'photos', label: 'Photos', kind: 'attachments' }]
  }))
  const created = ok(await callMcpTool(token, 'records_create', { org: org.slug, type: TYPE, fields: { name: 'test-records Album' } }))
  const id = (created.record as { id: string }).id
  return { org, user, token, id }
}

describe('records attachment upload tools', () => {
  it('refuses a field that holds no files, a file over 25 MB, and a caller who can\'t see the record', async () => {
    const { org, token, id } = await setup()
    const file = { filename: 'a.png', mime: 'image/png', size: 10 }

    expect(errorText(await callMcpTool(token, 'records_begin_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'name', ...file
    }))).toContain('not an attachments field')

    expect(errorText(await callMcpTool(token, 'records_begin_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', ...file, size: 25 * 1024 * 1024 + 1
    }))).toContain('File too large')

    const member = await addRecordsMember(sql, org.id, ['member'])
    const { token: memberToken } = await issueMcpBearer(sql, member.user.id, ['records.read', 'records.write'])
    expect((await callMcpTool(memberToken, 'records_begin_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', ...file
    })).isError).toBe(true)
  })

  it('hands out a key queued for the sweep until the URL expires', async () => {
    const { org, token, id } = await setup()
    const out = ok(await callMcpTool(token, 'records_begin_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', filename: 'Cover.PNG', mime: 'image/png', size: 10
    }))
    expect(out.key).toMatch(/^records\/[0-9a-f]{32}\.png$/)
    expect(out.method).toBe('PUT')
    expect(out.headers).toEqual({ 'Content-Type': 'image/png' })
    expect(out.uploadUrl).toContain(out.key as string)

    const [queued] = await sql<Array<{ deleted_at: Date }>>`
      SELECT deleted_at FROM records_attachment_trash WHERE storage_key = ${out.key as string}
    `
    expect(queued!.deleted_at.getTime()).toBeCloseTo(new Date(out.expiresAt as string).getTime(), -3)
    await sql`DELETE FROM records_attachment_trash WHERE storage_key = ${out.key as string}`
  })

  it('refuses a key never handed out and the key of a deleted file', async () => {
    const { org, token, id } = await setup()
    const complete = (key: string) => callMcpTool(token, 'records_complete_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', key, filename: 'x.png'
    })

    expect(errorText(await complete(`records/${randomBytes(16).toString('hex')}.png`))).toContain('Unknown upload key')
    expect(errorText(await complete('uploads/elsewhere.png'))).toContain('Unknown upload key')

    const deleted = `records/${randomBytes(16).toString('hex')}.png`
    await sql`INSERT INTO records_attachment_trash (storage_key) VALUES (${deleted})`
    try {
      expect(errorText(await complete(deleted))).toContain('Unknown upload key')
      expect(await sql`SELECT 1 FROM records_attachment_trash WHERE storage_key = ${deleted}`).toHaveLength(1)
    } finally {
      await sql`DELETE FROM records_attachment_trash WHERE storage_key = ${deleted}`
    }
  })

  it.skipIf(SKIP_S3)('refuses to complete before the file was PUT', async () => {
    const { org, token, id } = await setup()
    const begun = ok(await callMcpTool(token, 'records_begin_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', filename: 'a.png', mime: 'image/png', size: 10
    }))
    const key = begun.key as string
    storedKeys.push(key)

    expect(errorText(await callMcpTool(token, 'records_complete_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', key, filename: 'a.png'
    }))).toContain('Nothing has been uploaded')
    expect(await sql`SELECT 1 FROM records_attachment_trash WHERE storage_key = ${key}`).toHaveLength(1)
  })

  it.skipIf(SKIP_S3)('puts the uploaded file on the field, notes it on the timeline, and takes a key once', async () => {
    const { org, token, id } = await setup()
    const bytes = randomBytes(64)
    const begun = ok(await callMcpTool(token, 'records_begin_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', filename: 'cover.png', mime: 'image/png', size: bytes.byteLength
    }))
    const key = begun.key as string
    storedKeys.push(key)

    const put = await fetch(begun.uploadUrl as string, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes })
    expect(put.ok).toBe(true)

    const done = ok(await callMcpTool(token, 'records_complete_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', key, filename: 'cover.png'
    }))
    expect(done.file).toMatchObject({ name: 'cover.png', mime: 'image/png', size: bytes.byteLength })
    expect((done.changes as Array<{ field: string }>).map(c => c.field)).toEqual(['photos'])
    expect(await sql`SELECT 1 FROM records_attachment_trash WHERE storage_key = ${key}`).toHaveLength(0)

    const got = ok(await callMcpTool(token, 'records_get', { org: org.slug, type: TYPE, id }))
    const photos = (got.record as { fields: Record<string, Array<{ name: string }>> }).fields.photos!
    expect(photos.map(p => p.name)).toEqual(['cover.png'])

    const timeline = ok(await callMcpTool(token, 'records_list_timeline', { org: org.slug, type: TYPE, id }))
    const entries = timeline.entries as Array<{ action?: string, field?: string, viaClient: string | null }>
    expect(entries.find(e => e.action === 'field_changed' && e.field === 'photos')).toMatchObject({ viaClient: RECORDS_TEST_MCP_CLIENT_NAME })

    expect(errorText(await callMcpTool(token, 'records_complete_attachment_upload', {
      org: org.slug, type: TYPE, id, field: 'photos', key, filename: 'cover.png'
    }))).toContain('Unknown upload key')
  })
})
