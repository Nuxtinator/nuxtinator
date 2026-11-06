// DELETE /api/videos/:id
// Owner-only; users with `videos.moderate` can delete any video in the org.
// Side effect: row gone from DB. S3 deletes are best-effort and may fail
// silently (test bucket may not contain the key), but the DB row still goes.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupVideosTestData,
  createVideosOrgWith,
  addVideosMember,
  createTestVideo,
  withOrgHeader
} from '../helpers'

describe('DELETE /api/videos/:id', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupVideosTestData(sql)
  })

  it('returns 401 when unauthenticated', async () => {
    const err = await $fetch(`/api/videos/${randomUUID()}`, { method: 'DELETE' }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('owner can delete own video; row is removed from DB', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id })

    const res = await $fetch<{ success: boolean }>(
      `/api/videos/${video.id}`,
      { method: 'DELETE', ...withOrgHeader(auth, org.slug) }
    )
    expect(res.success).toBe(true)

    const rows = await sql<{ id: string }[]>`SELECT id FROM videos WHERE id = ${video.id}`
    expect(rows.length).toBe(0)
  })

  it('404 when the video does not exist', async () => {
    const { org, auth } = await createVideosOrgWith(sql, ['admin'])
    const err = await $fetch(`/api/videos/${randomUUID()}`, {
      method: 'DELETE', ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('non-owner member without videos.moderate gets 403; row survives', async () => {
    const { org, user: owner } = await createVideosOrgWith(sql, ['admin'])
    const other = await addVideosMember(sql, org.id, ['member'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: owner.id, visibility: 'org' })

    const err = await $fetch(`/api/videos/${video.id}`, {
      method: 'DELETE', ...withOrgHeader(other.auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)

    const rows = await sql<{ id: string }[]>`SELECT id FROM videos WHERE id = ${video.id}`
    expect(rows.length).toBe(1)
  })

  it('non-owner admin (has videos.moderate) can delete someone else\'s org video', async () => {
    const { org, user: owner } = await createVideosOrgWith(sql, ['admin'])
    const moderator = await addVideosMember(sql, org.id, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: owner.id, visibility: 'org' })

    await $fetch(`/api/videos/${video.id}`, {
      method: 'DELETE', ...withOrgHeader(moderator.auth, org.slug)
    })
    const rows = await sql<{ id: string }[]>`SELECT id FROM videos WHERE id = ${video.id}`
    expect(rows.length).toBe(0)
  })

  it('RLS isolation: a non-member of orgA gets 404 deleting orgA\'s videos', async () => {
    const a = await createVideosOrgWith(sql, ['admin'])
    const b = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: a.org.id, user_id: a.user.id })

    // b.user uses b.org as active org → RLS hides a.org rows → 404.
    const err = await $fetch(`/api/videos/${video.id}`, {
      method: 'DELETE', ...withOrgHeader(b.auth, b.org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)

    // And the row is still there.
    const rows = await sql<{ id: string }[]>`SELECT id FROM videos WHERE id = ${video.id}`
    expect(rows.length).toBe(1)
  })
})
