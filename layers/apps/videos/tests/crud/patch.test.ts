// PATCH /api/videos/:id
// Update title and/or visibility. Owner can edit own; only users with
// `videos.moderate` can edit someone else's. No-op updates return 400.
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

describe('PATCH /api/videos/:id', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupVideosTestData(sql)
  })

  it('returns 401 when unauthenticated', async () => {
    const err = await $fetch(`/api/videos/${randomUUID()}`, {
      method: 'PATCH', body: { title: 'x' }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('owner can update title; DB row reflects the change', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id })

    const res = await $fetch<{ success: boolean, video: { title: string } }>(
      `/api/videos/${video.id}`,
      { method: 'PATCH', body: { title: '  My new title  ' }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.video.title).toBe('My new title')

    const rows = await sql<{ title: string }[]>`SELECT title FROM videos WHERE id = ${video.id}`
    expect(rows[0]!.title).toBe('My new title')
  })

  it('owner can update visibility to org', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id, visibility: 'private' })

    await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: { visibility: 'org' }, ...withOrgHeader(auth, org.slug)
    })

    const rows = await sql<{ visibility: string }[]>`SELECT visibility FROM videos WHERE id = ${video.id}`
    expect(rows[0]!.visibility).toBe('org')
  })

  it('400 when no updates are provided', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id })
    const err = await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: {}, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('400 when title is empty/whitespace', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id })
    const err = await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: { title: '   ' }, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('400 when visibility is not in the allow-list', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id })
    const err = await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: { visibility: 'world' }, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('404 when the video does not exist in the org', async () => {
    const { org, auth } = await createVideosOrgWith(sql, ['admin'])
    const err = await $fetch(`/api/videos/${randomUUID()}`, {
      method: 'PATCH', body: { title: 'x' }, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('non-owner member without videos.moderate gets 403', async () => {
    const { org, user: owner } = await createVideosOrgWith(sql, ['admin'])
    // Add a plain member — default grants for `member` include videos.write
    // (own-video CRUD) but NOT videos.moderate.
    const other = await addVideosMember(sql, org.id, ['member'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: owner.id, visibility: 'org' })

    const err = await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: { title: 'hijack' }, ...withOrgHeader(other.auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })

  it('non-owner admin (has videos.moderate) can update someone else\'s org video', async () => {
    const { org, user: owner } = await createVideosOrgWith(sql, ['admin'])
    // Add a second admin — admins get all permissions including videos.moderate.
    const moderator = await addVideosMember(sql, org.id, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: owner.id, visibility: 'org' })

    await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: { title: 'moderated' }, ...withOrgHeader(moderator.auth, org.slug)
    })

    const rows = await sql<{ title: string }[]>`SELECT title FROM videos WHERE id = ${video.id}`
    expect(rows[0]!.title).toBe('moderated')
  })

  it('RLS isolation: a non-member of orgA cannot patch orgA\'s videos', async () => {
    const a = await createVideosOrgWith(sql, ['admin'])
    const b = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: a.org.id, user_id: a.user.id })

    // b.user tries to patch a.org's video, with X-Active-Org = a.org.slug → 404 (no membership).
    const err1 = await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: { title: 'x' }, ...withOrgHeader(b.auth, a.org.slug)
    }).catch(e => e)
    expect(err1.statusCode).toBe(404)

    // b.user with X-Active-Org=b.org → RLS hides a.org's row → 404 "not found".
    const err2 = await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH', body: { title: 'x' }, ...withOrgHeader(b.auth, b.org.slug)
    }).catch(e => e)
    expect(err2.statusCode).toBe(404)
  })
})
