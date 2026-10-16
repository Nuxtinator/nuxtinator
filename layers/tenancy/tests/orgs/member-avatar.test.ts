import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOrgWithAdmin,
  createTenancyUser,
  createTestOrg,
  addTestMembership,
  getAuthHeaders,
  publicStorageConfigured
} from '../helpers'

// 1x1 PNG.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000d49444154789c63f8cf000000010100000118c4f3a90000000049454e44ae426082',
  'hex'
)
const PHOTO = 'https://example.com/photo.png'

describe('/api/o/[orgSlug]/members/[userId]/avatar', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupTenancyTestData(sql)
  })

  async function avatarOf(id: string): Promise<string> {
    return (await sql<{ avatar: string }[]>`SELECT avatar FROM users WHERE id = ${id}`)[0]!.avatar
  }

  async function memberWithAvatar(orgId: string, opts: { is_admin?: boolean } = {}) {
    const member = await createTenancyUser(sql, opts)
    await addTestMembership(sql, { user_id: member.id, org_id: orgId, roles: ['member'] })
    await sql`UPDATE users SET avatar = ${PHOTO} WHERE id = ${member.id}`
    return member
  }

  it('members list includes each member\'s avatar and whether the caller may change it', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const member = await memberWithAvatar(org.id)
    const operator = await memberWithAvatar(org.id, { is_admin: true })

    type Row = { user_id: string, avatar: string | null, editable: boolean }
    const rows = async (headers: typeof auth) => (await $fetch<{ rows: Row[] }>(`/api/o/${org.slug}/members`, headers)).rows

    const asAdmin = await rows(auth)
    expect(asAdmin.find(r => r.user_id === member.id)).toMatchObject({ avatar: PHOTO, editable: true })
    expect(asAdmin.find(r => r.user_id === operator.id)?.editable).toBe(false)

    expect((await rows(getAuthHeaders(member))).every(r => !r.editable)).toBe(true)
    expect((await rows(getAuthHeaders(operator))).every(r => r.editable)).toBe(true)
  })

  it('org admin can remove a member\'s avatar', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const member = await memberWithAvatar(org.id)

    const res = await $fetch(`/api/o/${org.slug}/members/${member.id}/avatar`, { method: 'DELETE', ...auth })
    expect(res.avatar).toBeNull()
    expect(await avatarOf(member.id)).toBe('')

    const [log] = await sql`SELECT org_id, user_id FROM activity_logs WHERE event_type = 'org_member_avatar_removed' AND record_id = ${member.id}`
    expect(log).toMatchObject({ org_id: org.id })
  })

  it('a plain member cannot change another member\'s avatar', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const member = await memberWithAvatar(org.id)
    const other = await memberWithAvatar(org.id)

    const err = await $fetch(`/api/o/${org.slug}/members/${other.id}/avatar`, { method: 'DELETE', ...getAuthHeaders(member) }).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(await avatarOf(other.id)).toBe(PHOTO)
  })

  it('an operator admin can change a member\'s avatar without the org permission', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const operator = await memberWithAvatar(org.id, { is_admin: true })
    const member = await memberWithAvatar(org.id)

    await $fetch(`/api/o/${org.slug}/members/${member.id}/avatar`, { method: 'DELETE', ...getAuthHeaders(operator) })
    expect(await avatarOf(member.id)).toBe('')
  })

  it('an org admin cannot change an operator admin\'s avatar', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const operator = await memberWithAvatar(org.id, { is_admin: true })

    const err = await $fetch(`/api/o/${org.slug}/members/${operator.id}/avatar`, { method: 'DELETE', ...auth }).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(await avatarOf(operator.id)).toBe(PHOTO)
  })

  it('an org admin cannot change the avatar of a member who is also in another org', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const member = await memberWithAvatar(org.id)
    const otherOrg = await createTestOrg(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: otherOrg.id, roles: ['member'] })

    const rows = (await $fetch<{ rows: { user_id: string, editable: boolean }[] }>(`/api/o/${org.slug}/members`, auth)).rows
    expect(rows.find(r => r.user_id === member.id)?.editable).toBe(false)

    const err = await $fetch(`/api/o/${org.slug}/members/${member.id}/avatar`, { method: 'DELETE', ...auth }).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(await avatarOf(member.id)).toBe(PHOTO)
  })

  it('an operator admin can change the avatar of a member who is also in another org', async () => {
    const { org } = await createOrgWithAdmin(sql)
    const operator = await memberWithAvatar(org.id, { is_admin: true })
    const member = await memberWithAvatar(org.id)
    const otherOrg = await createTestOrg(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: otherOrg.id, roles: ['member'] })

    await $fetch(`/api/o/${org.slug}/members/${member.id}/avatar`, { method: 'DELETE', ...getAuthHeaders(operator) })
    expect(await avatarOf(member.id)).toBe('')
  })

  it('returns 404 for a user who is not a member of this org', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const otherOrg = await createTestOrg(sql)
    const outsider = await memberWithAvatar(otherOrg.id)

    const err = await $fetch(`/api/o/${org.slug}/members/${outsider.id}/avatar`, { method: 'DELETE', ...auth }).catch(e => e)
    expect(err.statusCode).toBe(404)
    expect(await avatarOf(outsider.id)).toBe(PHOTO)
  })

  it.skipIf(!publicStorageConfigured())('org admin can upload a member\'s avatar', async () => {
    const { org, auth } = await createOrgWithAdmin(sql)
    const member = await createTenancyUser(sql)
    await addTestMembership(sql, { user_id: member.id, org_id: org.id, roles: ['member'] })

    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(TINY_PNG)], { type: 'image/png' }), 'a.png')
    const res = await $fetch<{ avatar: string }>(`/api/o/${org.slug}/members/${member.id}/avatar`, { method: 'POST', body, ...auth })
    expect(res.avatar).toMatch(/^https?:\/\//)
    expect(await avatarOf(member.id)).toBe(res.avatar)

    await $fetch(`/api/o/${org.slug}/members/${member.id}/avatar`, { method: 'DELETE', ...auth })
  })
})
