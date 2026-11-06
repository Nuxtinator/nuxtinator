// GET /api/videos?scope=mine|team
// Returns videos owned by the caller (mine) or the team and org videos the
// caller may see in the active org (team). RLS scopes the underlying SELECT
// to the active org and hides other people's private videos.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupVideosTestData,
  createVideosOrgWith,
  addVideosMember,
  createTestVideo,
  withOrgHeader
} from '../helpers'

interface VideoResp {
  id: string
  title: string | null
  visibility: 'private' | 'team' | 'org'
  linkEnabled: boolean
  userId: string
  shareToken: string
  viewCount: number
  playCount: number
}

describe('GET /api/videos', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupVideosTestData(sql)
  })

  it('returns 401 when unauthenticated', async () => {
    const err = await $fetch('/api/videos', { method: 'GET' }).catch(e => e)
    // No auth cookie → requireAuth throws 401 inside runWithOrgContext.
    expect(err.statusCode).toBe(401)
  })

  it('scope=mine: returns only the caller\'s videos across all visibilities', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const other = await addVideosMember(sql, org.id, ['member'])

    // Caller owns one private + one org video.
    const mine1 = await createTestVideo(sql, { org_id: org.id, user_id: user.id, visibility: 'private' })
    const mine2 = await createTestVideo(sql, { org_id: org.id, user_id: user.id, visibility: 'org' })
    // Other member's video — should NOT appear under scope=mine.
    await createTestVideo(sql, { org_id: org.id, user_id: other.user.id, visibility: 'org' })

    const res = await $fetch<{ videos: VideoResp[] }>(
      '/api/videos',
      { method: 'GET', query: { scope: 'mine' }, ...withOrgHeader(auth, org.slug) }
    )

    const ids = res.videos.map(v => v.id).sort()
    expect(ids).toEqual([mine1.id, mine2.id].sort())
    expect(res.videos.every(v => v.userId === user.id)).toBe(true)
  })

  it('scope=team: returns org-shared videos from any uploader in the active org', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const other = await addVideosMember(sql, org.id, ['member'])

    // Two org-shared videos from different uploaders.
    const a = await createTestVideo(sql, { org_id: org.id, user_id: user.id, visibility: 'org' })
    const b = await createTestVideo(sql, { org_id: org.id, user_id: other.user.id, visibility: 'org' })
    // Private videos, even with their link on, should not appear in team scope.
    await createTestVideo(sql, { org_id: org.id, user_id: user.id, visibility: 'private' })
    await createTestVideo(sql, { org_id: org.id, user_id: other.user.id, visibility: 'private', link_enabled: true })

    const res = await $fetch<{ videos: VideoResp[] }>(
      '/api/videos',
      { method: 'GET', query: { scope: 'team' }, ...withOrgHeader(auth, org.slug) }
    )
    const ids = res.videos.map(v => v.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())
    expect(res.videos.every(v => v.visibility === 'org')).toBe(true)
  })

  it('defaults to scope=mine when query param is missing or invalid', async () => {
    const { org, user, auth } = await createVideosOrgWith(sql, ['admin'])
    const other = await addVideosMember(sql, org.id, ['member'])
    const own = await createTestVideo(sql, { org_id: org.id, user_id: user.id, visibility: 'org' })
    await createTestVideo(sql, { org_id: org.id, user_id: other.user.id, visibility: 'org' })

    const res = await $fetch<{ videos: VideoResp[] }>(
      '/api/videos',
      { method: 'GET', ...withOrgHeader(auth, org.slug) }
    )
    expect(res.videos.map(v => v.id)).toContain(own.id)
    // Other user's org video should not be in the default scope.
    expect(res.videos.every(v => v.userId === user.id)).toBe(true)
  })

  it('RLS isolation: org A members cannot see org B\'s videos via scope=team', async () => {
    const a = await createVideosOrgWith(sql, ['admin'])
    const b = await createVideosOrgWith(sql, ['admin'])
    // Seed an org-shared video in org B.
    await createTestVideo(sql, { org_id: b.org.id, user_id: b.user.id, visibility: 'org' })

    // Caller is a member of org A only — scope=team in org A returns nothing.
    const res = await $fetch<{ videos: VideoResp[] }>(
      '/api/videos',
      { method: 'GET', query: { scope: 'team' }, ...withOrgHeader(a.auth, a.org.slug) }
    )
    expect(res.videos).toEqual([])
  })

  it('returns 404 if the caller is not a member of the org in X-Active-Org', async () => {
    const a = await createVideosOrgWith(sql, ['admin'])
    const b = await createVideosOrgWith(sql, ['admin'])
    // a.user tries to access b.org — middleware refuses (no membership row).
    const err = await $fetch('/api/videos', {
      method: 'GET',
      ...withOrgHeader(a.auth, b.org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})
