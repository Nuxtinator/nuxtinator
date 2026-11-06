// Private / team / org videos and the separate public link: RLS hides private
// videos from everyone but their uploader, team videos answer 404 off the
// team (admins see them with "show all teams"), and team and org videos
// outlive their uploader's account.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  getAppUserDb,
  cleanupVideosTestData,
  createVideosOrgWith,
  addVideosMember,
  createTestVideo,
  withOrgHeader
} from '../helpers'

type Headers = ReturnType<typeof withOrgHeader>

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err: unknown) {
    return (err as { statusCode?: number }).statusCode ?? 0
  }
}

function showAll(h: Headers) {
  return { headers: { ...h.headers, 'x-show-all-teams': '1' } }
}

describe('videos: private, team and org', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupVideosTestData(sql)
  })

  async function createGroup(slug: string, h: Headers, name: string, memberIds: string[]) {
    const group = await $fetch<{ id: string }>(`/api/o/${slug}/groups`, { method: 'POST', body: { name }, ...h })
    for (const userId of memberIds) {
      await $fetch(`/api/o/${slug}/groups/${group.id}/members/${userId}`, { method: 'PUT', ...h })
    }
    return group
  }

  // An org in teams mode with a Dev team (uploader + insider) and an Ops team
  // (outsider), and a video limited to Dev.
  async function setup() {
    const { org, user: admin, auth } = await createVideosOrgWith(sql, ['admin'])
    const adminH = withOrgHeader(auth, org.slug)
    const uploader = await addVideosMember(sql, org.id, ['member'])
    const insider = await addVideosMember(sql, org.id, ['member'])
    const outsider = await addVideosMember(sql, org.id, ['member'])
    await $fetch(`/api/o/${org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'teams' }, ...adminH })
    const dev = await createGroup(org.slug, adminH, `test-videos-dev-${randomUUID().slice(0, 6)}`, [uploader.user.id, insider.user.id])
    const ops = await createGroup(org.slug, adminH, `test-videos-ops-${randomUUID().slice(0, 6)}`, [outsider.user.id])
    const video = await createTestVideo(sql, { org_id: org.id, user_id: uploader.user.id, visibility: 'team', team_id: dev.id })
    return {
      org,
      admin,
      adminH,
      dev,
      ops,
      video,
      uploader: { ...uploader, h: withOrgHeader(uploader.auth, org.slug) },
      insider: { ...insider, h: withOrgHeader(insider.auth, org.slug) },
      outsider: { ...outsider, h: withOrgHeader(outsider.auth, org.slug) }
    }
  }

  it('lists a team video for the team and the uploader, not for others', async () => {
    const s = await setup()
    const shared = async (h: Headers) =>
      (await $fetch<{ videos: { id: string, team: { id: string } | null }[] }>('/api/videos', { query: { scope: 'team' }, ...h })).videos
    const forInsider = await shared(s.insider.h)
    expect(forInsider.map(v => v.id)).toContain(s.video.id)
    expect(forInsider.find(v => v.id === s.video.id)!.team!.id).toBe(s.dev.id)
    expect((await shared(s.uploader.h)).map(v => v.id)).toContain(s.video.id)
    expect((await shared(s.outsider.h)).map(v => v.id)).not.toContain(s.video.id)
    expect((await shared(s.adminH)).map(v => v.id)).not.toContain(s.video.id)
    expect((await shared(showAll(s.adminH))).map(v => v.id)).toContain(s.video.id)
  })

  it('answers 404 to someone off the team on every by-id and share route', async () => {
    const s = await setup()
    const h = s.outsider.h
    const token = s.video.share_token
    expect(await status($fetch(`/api/videos/${s.video.id}`, { method: 'PATCH', body: { title: 'x' }, ...h }))).toBe(404)
    expect(await status($fetch(`/api/videos/${s.video.id}`, { method: 'DELETE', ...h }))).toBe(404)
    expect(await status($fetch(`/api/videos/share/${token}`, { ...h }))).toBe(404)
    expect(await status($fetch(`/api/videos/share/${token}/view`, { method: 'POST', ...h }))).toBe(404)
    expect(await status($fetch(`/api/videos/share/${token}/play`, { method: 'POST', ...h }))).toBe(404)
    expect(await status($fetch(`/api/videos/share/${token}`, { method: 'PATCH', body: { title: 'x' }, ...h }))).toBe(404)
    // An admin off the team: 404 until "show all teams" is on.
    expect(await status($fetch(`/api/videos/share/${token}`, { ...s.adminH }))).toBe(404)
    expect(await status($fetch(`/api/videos/share/${token}`, { ...showAll(s.adminH) }))).toBe(200)
    expect(await status($fetch(`/api/videos/share/${token}`, { ...s.insider.h }))).toBe(200)
  })

  it('opens a team video to anyone with the link once its link is on', async () => {
    const s = await setup()
    await $fetch(`/api/videos/${s.video.id}`, { method: 'PATCH', body: { linkEnabled: true }, ...s.uploader.h })
    expect(await status($fetch(`/api/videos/share/${s.video.share_token}`))).toBe(200)
    expect(await status($fetch(`/api/videos/share/${s.video.share_token}`, { ...s.outsider.h }))).toBe(200)
  })

  it('lets the uploader keep seeing a team video after leaving the team', async () => {
    const s = await setup()
    await sql`DELETE FROM group_members WHERE group_id = ${s.dev.id} AND user_id = ${s.uploader.user.id}`
    expect(await status($fetch(`/api/videos/share/${s.video.share_token}`, { ...s.uploader.h }))).toBe(200)
    const mine = await $fetch<{ videos: { id: string }[] }>('/api/videos', { query: { scope: 'mine' }, ...s.uploader.h })
    expect(mine.videos.map(v => v.id)).toContain(s.video.id)
  })

  it('shares only with a team the caller is on', async () => {
    const s = await setup()
    const own = await createTestVideo(sql, { org_id: s.org.id, user_id: s.uploader.user.id, visibility: 'private' })
    const res = await $fetch<{ video: { visibility: string, team: { id: string } } }>(`/api/videos/${own.id}`, {
      method: 'PATCH', body: { visibility: 'team', teamId: s.dev.id }, ...s.uploader.h
    })
    expect(res.video.visibility).toBe('team')
    expect(res.video.team.id).toBe(s.dev.id)
    expect(await status($fetch(`/api/videos/${own.id}`, {
      method: 'PATCH', body: { visibility: 'team', teamId: s.ops.id }, ...s.uploader.h
    }))).toBe(403)
    expect(await status($fetch(`/api/videos/${own.id}`, {
      method: 'PATCH', body: { visibility: 'team' }, ...s.uploader.h
    }))).toBe(400)
  })

  it('upload-complete stores a team video and the link switch; `public` means org with the link on', async () => {
    const s = await setup()
    const teamId = randomUUID()
    await $fetch('/api/videos/upload-complete', {
      method: 'POST', body: { videoId: teamId, videoKey: `${teamId}.webm`, visibility: 'team', teamId: s.dev.id, linkEnabled: true }, ...s.uploader.h
    })
    const publicId = randomUUID()
    await $fetch('/api/videos/upload-complete', {
      method: 'POST', body: { videoId: publicId, videoKey: `${publicId}.webm`, visibility: 'public' }, ...s.uploader.h
    })
    const rows = await sql<{ id: string, visibility: string, team_id: string | null, link_enabled: boolean }[]>`
      SELECT id, visibility, team_id, link_enabled FROM videos WHERE id IN (${teamId}, ${publicId})
    `
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get(teamId)).toMatchObject({ visibility: 'team', team_id: s.dev.id, link_enabled: true })
    expect(byId.get(publicId)).toMatchObject({ visibility: 'org', team_id: null, link_enabled: true })
  })

  it('only the uploader can make a video private; moderators never reach others\' private videos', async () => {
    const s = await setup()
    const orgVideo = await createTestVideo(sql, { org_id: s.org.id, user_id: s.uploader.user.id, visibility: 'org' })
    expect(await status($fetch(`/api/videos/${orgVideo.id}`, {
      method: 'PATCH', body: { visibility: 'private' }, ...s.adminH
    }))).toBe(403)
    const priv = await createTestVideo(sql, { org_id: s.org.id, user_id: s.uploader.user.id, visibility: 'private' })
    expect(await status($fetch(`/api/videos/${priv.id}`, { method: 'DELETE', ...showAll(s.adminH) }))).toBe(404)
    const shared = await $fetch<{ videos: { id: string }[] }>('/api/videos', { query: { scope: 'team' }, ...showAll(s.adminH) })
    expect(shared.videos.map(v => v.id)).not.toContain(priv.id)
  })

  it('RLS hides a private video from an org transaction that isn\'t its uploader\'s', async () => {
    const s = await setup()
    const priv = await createTestVideo(sql, { org_id: s.org.id, user_id: s.uploader.user.id, visibility: 'private' })
    const app = getAppUserDb()
    const visibleTo = (userId: string | null) => app.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${s.org.id}, true)`
      if (userId) await tx`select set_config('app.current_user', ${userId}, true)`
      return (await tx<{ n: number }[]>`select count(*)::int as n from videos where id = ${priv.id}`)[0]!.n
    })
    expect(await visibleTo(s.uploader.user.id)).toBe(1)
    expect(await visibleTo(s.insider.user.id)).toBe(0)
    expect(await visibleTo(null)).toBe(0)
    // Nobody can move a video into someone else's private space.
    const moved = app.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${s.org.id}, true)`
      await tx`select set_config('app.current_user', ${s.insider.user.id}, true)`
      await tx`update videos set visibility = 'private', team_id = null where id = ${s.video.id}`
    })
    await expect(moved).rejects.toThrow(/row-level security/)
  })

  it('a private video with its link on opens signed out', async () => {
    const s = await setup()
    const priv = await createTestVideo(sql, { org_id: s.org.id, user_id: s.uploader.user.id, visibility: 'private', link_enabled: true })
    expect(await status($fetch(`/api/videos/share/${priv.share_token}`))).toBe(200)
    expect(await status($fetch(`/api/videos/share/${priv.share_token}/view`, { method: 'POST' }))).toBe(200)
    expect(await status($fetch(`/api/videos/share/${priv.share_token}`, { method: 'PATCH', body: { title: 'x' }, ...s.insider.h }))).toBe(403)
  })

  it('deleting an account keeps its team and org videos and deletes its private ones', async () => {
    const s = await setup()
    const orgVideo = await createTestVideo(sql, { org_id: s.org.id, user_id: s.uploader.user.id, visibility: 'org' })
    const priv = await createTestVideo(sql, { org_id: s.org.id, user_id: s.uploader.user.id, visibility: 'private', link_enabled: true })

    await sql`UPDATE users SET is_admin = true WHERE id = ${s.admin.id}`
    await $fetch(`/api/admin/users/${s.uploader.user.id}`, { method: 'DELETE', ...s.adminH })

    const rows = await sql<{ id: string, user_id: string | null }[]>`
      SELECT id, user_id FROM videos WHERE id IN (${s.video.id}, ${orgVideo.id}, ${priv.id})
    `
    expect(rows.map(r => r.id).sort()).toEqual([s.video.id, orgVideo.id].sort())
    expect(rows.every(r => r.user_id === null)).toBe(true)
    // The private video's storage key was queued and, once the hook ran, removed.
    const queued = await sql`SELECT 1 FROM videos_blob_deletes WHERE s3_key = ${priv.s3_key}`
    expect(queued.length).toBe(0)

    // Moderators manage the orphaned videos; the team still sees its video.
    expect(await status($fetch(`/api/videos/share/${s.video.share_token}`, { ...s.insider.h }))).toBe(200)
    expect(await status($fetch(`/api/videos/${orgVideo.id}`, { method: 'PATCH', body: { title: 'kept' }, ...s.adminH }))).toBe(200)
  })

  it('a group in use by a team video can\'t be deleted', async () => {
    const s = await setup()
    expect(await status($fetch(`/api/o/${s.org.slug}/groups/${s.dev.id}`, { method: 'DELETE', ...s.adminH }))).toBe(409)
  })

  it('deleting an org with team videos succeeds', async () => {
    const s = await setup()
    await sql`DELETE FROM orgs WHERE id = ${s.org.id}`
    const left = await sql`SELECT 1 FROM videos WHERE org_id = ${s.org.id}`
    expect(left.length).toBe(0)
  })
})
