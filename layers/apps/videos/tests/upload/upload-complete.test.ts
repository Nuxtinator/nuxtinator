// POST /api/videos/upload-complete
// Persists video metadata after the browser has uploaded to S3. The row
// has user_id = caller, a random share_token, and the supplied visibility
// (default 'private'). RLS sets org_id = active org via the
// `current_org_id()` DEFAULT, since the handler doesn't pass it explicitly.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupVideosTestData,
  createVideosOrgWith,
  withOrgHeader
} from '../helpers'

interface CompleteResp {
  success: boolean
  videoId: string
  shareToken: string
}

describe('POST /api/videos/upload-complete', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupVideosTestData(sql)
  })

  it('returns 401 when unauthenticated', async () => {
    const err = await $fetch('/api/videos/upload-complete', {
      method: 'POST', body: { videoId: randomUUID(), videoKey: 'foo.webm' }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('inserts a videos row with default visibility=private and a generated share_token', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const videoId = randomUUID()
    const videoKey = `${videoId}.webm`

    const res = await $fetch<CompleteResp>(
      '/api/videos/upload-complete',
      {
        method: 'POST',
        body: { videoId, videoKey, duration: 42, fileSize: 12345, width: 1920, height: 1080 },
        ...withOrgHeader(auth, org.slug)
      }
    )

    expect(res.success).toBe(true)
    expect(res.videoId).toBe(videoId)
    expect(res.shareToken).toMatch(/^[0-9a-f]{32}$/)

    const rows = await sql<{ user_id: string, org_id: string, visibility: string, s3_key: string, duration: number, title: string }[]>`
      SELECT user_id, org_id, visibility, s3_key, duration, title FROM videos WHERE id = ${videoId}
    `
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row.user_id).toBe(user.id)
    expect(row.org_id).toBe(org.id)
    expect(row.visibility).toBe('private')
    expect(row.s3_key).toBe(`videos/${videoKey}`)
    expect(row.duration).toBe(42)
    // Title is auto-generated when none supplied — non-empty timestamp string.
    expect(row.title.length).toBeGreaterThan(0)
  })

  it('persists explicit visibility=org and thumbnail key when provided', async () => {
    const { org, auth } = await createVideosOrgWith(sql, ['admin'])
    const videoId = randomUUID()

    await $fetch<CompleteResp>('/api/videos/upload-complete', {
      method: 'POST',
      body: {
        videoId,
        videoKey: `${videoId}.mp4`,
        thumbnailKey: `${videoId}-thumb.jpg`,
        visibility: 'org',
        source: 'upload',
        originalFilename: 'big.mp4',
        originalFileSize: 99_999_999,
        compressionRatio: 12.5
      },
      ...withOrgHeader(auth, org.slug)
    })

    const rows = await sql<{ visibility: string, thumbnail_url: string, source: string, original_filename: string, compression_ratio: string }[]>`
      SELECT visibility, thumbnail_url, source, original_filename, compression_ratio
      FROM videos WHERE id = ${videoId}
    `
    expect(rows[0]!.visibility).toBe('org')
    expect(rows[0]!.thumbnail_url).toBe(`videos/${videoId}-thumb.jpg`)
    expect(rows[0]!.source).toBe('upload')
    expect(rows[0]!.original_filename).toBe('big.mp4')
    expect(Number(rows[0]!.compression_ratio)).toBe(12.5)
  })

  it('400 when videoId or videoKey is missing', async () => {
    const { org, auth } = await createVideosOrgWith(sql, ['admin'])
    const err = await $fetch('/api/videos/upload-complete', {
      method: 'POST', body: { videoKey: 'something.webm' }, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('rejects object keys that were not derived from videoId', async () => {
    const { org, auth } = await createVideosOrgWith(sql, ['admin'])
    const videoId = randomUUID()
    const victimId = randomUUID()
    const cases = [
      { videoId, videoKey: `${victimId}.webm` },
      { videoId, videoKey: `${videoId}.webm`, thumbnailKey: `${victimId}-thumb.jpg` },
      { videoId, videoKey: `${videoId}.webm/../${victimId}.webm` },
      { videoId: 'not-a-uuid', videoKey: 'not-a-uuid.webm' }
    ]
    for (const body of cases) {
      const err = await $fetch('/api/videos/upload-complete', {
        method: 'POST', body, ...withOrgHeader(auth, org.slug)
      }).catch(e => e)
      expect(err.statusCode).toBe(400)
    }
    const rows = await sql`SELECT id FROM videos WHERE id = ${videoId}`
    expect(rows.length).toBe(0)
  })

  it('coerces invalid visibility back to private', async () => {
    const { org, auth } = await createVideosOrgWith(sql, ['admin'])
    const videoId = randomUUID()
    await $fetch<CompleteResp>('/api/videos/upload-complete', {
      method: 'POST',
      body: { videoId, videoKey: `${videoId}.webm`, visibility: 'world-readable' },
      ...withOrgHeader(auth, org.slug)
    })
    const rows = await sql<{ visibility: string }[]>`SELECT visibility FROM videos WHERE id = ${videoId}`
    expect(rows[0]!.visibility).toBe('private')
  })

  it('410 when the videos app is disabled for the active org', async () => {
    const { org, auth } = await createVideosOrgWith(sql, ['admin'])
    await sql`
      INSERT INTO org_apps (org_id, app_id, enabled, source)
      VALUES (${org.id}, 'videos', false, 'org_admin')
      ON CONFLICT (org_id, app_id) DO UPDATE SET enabled = excluded.enabled
    `
    const err = await $fetch('/api/videos/upload-complete', {
      method: 'POST',
      body: { videoId: randomUUID(), videoKey: 'foo.webm' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(410)
  })
})
