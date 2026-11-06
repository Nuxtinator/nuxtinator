// PATCH /api/videos/share/:token
// Rename a video from its public /watch/:token page. That URL is org-exempt,
// so requests carry no X-Active-Org header — this endpoint resolves the
// video's own org from the token (withRecordOrgContext) rather than the active
// org. Only the owner may rename.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupVideosTestData,
  createVideosOrgWith,
  addVideosMember,
  createTestVideo
} from '../helpers'

describe('PATCH /api/videos/share/:token', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupVideosTestData(sql)
  })

  it('owner renames their private video with NO active-org header (the watch-page path)', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, {
      org_id: org.id, user_id: user.id, visibility: 'private'
    })

    // `...auth` sends only the auth cookie — no X-Active-Org, exactly like the
    // org-exempt /watch/:token page. This used to 404 ("organization does not
    // exist") because /api/videos/:id reads the org from that header.
    const res = await $fetch<{ success: boolean, video: { title: string } }>(
      `/api/videos/share/${video.share_token}`,
      { method: 'PATCH', body: { title: '  Renamed from watch  ' }, ...auth }
    )
    expect(res.video.title).toBe('Renamed from watch')

    const rows = await sql<{ title: string }[]>`SELECT title FROM videos WHERE id = ${video.id}`
    expect(rows[0]!.title).toBe('Renamed from watch')
  })

  it('returns 401 when unauthenticated', async () => {
    const { org, user } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id })

    const err = await $fetch(`/api/videos/share/${video.share_token}`, {
      method: 'PATCH', body: { title: 'x' }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('403 when an authenticated non-owner tries to rename', async () => {
    const { org, user: owner } = await createVideosOrgWith(sql, ['admin'])
    const other = await addVideosMember(sql, org.id, ['member'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: owner.id, visibility: 'org' })

    const err = await $fetch(`/api/videos/share/${video.share_token}`, {
      method: 'PATCH', body: { title: 'hijack' }, ...other.auth
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })

  it('400 when title is empty/whitespace', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: user.id })

    const err = await $fetch(`/api/videos/share/${video.share_token}`, {
      method: 'PATCH', body: { title: '   ' }, ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('404 for an unknown share token', async () => {
    const { auth } = await createVideosOrgWith(sql, ['admin'])
    const err = await $fetch('/api/videos/share/test-videos-nonexistent-token', {
      method: 'PATCH', body: { title: 'x' }, ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})
