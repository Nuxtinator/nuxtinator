// Team rows on a record type's permissions: a team's grants add to what
// roles give its members, only the org's teams can be named, and a team in
// use can't be deleted.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

async function makeTeam(owner: Opts, orgSlug: string, memberIds: string[]): Promise<string> {
  const team = await $fetch<{ id: string }>(`/api/o/${orgSlug}/groups`, {
    method: 'POST',
    body: { name: `test-records-team-${Math.random().toString(36).slice(2, 8)}` },
    ...owner
  })
  for (const id of memberIds) {
    await $fetch(`/api/o/${orgSlug}/groups/${team.id}/members/${id}`, { method: 'PUT', ...owner })
  }
  return team.id
}

describe('team grants on record types', () => {
  it('a team with view_all sees every record of the type; others keep their role\'s answer', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const admin = withOrgHeader(auth, org.slug)
    const insider = await addRecordsMember(sql, org.id)
    const outsider = await addRecordsMember(sql, org.id)
    const team = await makeTeam(admin, org.slug, [insider.user.id])

    const item = await $fetch<{ id: string }>('/api/records/entries/item', { method: 'POST', body: { fields: { name: 'test-records Team item' } }, ...admin })
    const view = await $fetch<{ teams: Array<{ id: string }>, teamGrants: Record<string, Record<string, true>> }>(
      '/api/records/schema/types/item/role-grants',
      { method: 'PUT', body: { grants: {}, teamGrants: { [team]: { view_all: true, update: true, delete: false } } }, ...admin }
    )
    expect(view.teams.map(t => t.id)).toContain(team)
    expect(view.teamGrants).toEqual({ [team]: { view_all: true, update: true } })

    expect((await $fetch<{ id: string }>(`/api/records/entries/item/${item.id}`, withOrgHeader(insider.auth, org.slug))).id).toBe(item.id)
    await expect($fetch(`/api/records/entries/item/${item.id}`, withOrgHeader(outsider.auth, org.slug))).rejects.toMatchObject({ statusCode: 404 })

    await expect($fetch(`/api/o/${org.slug}/groups/${team}`, { method: 'DELETE', ...admin })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects groups that are not the org\'s', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const admin = withOrgHeader(auth, org.slug)
    await expect($fetch('/api/records/schema/types/item/role-grants', {
      method: 'PUT',
      body: { grants: {}, teamGrants: { '00000000-0000-4000-8000-000000000000': { read: true } } },
      ...admin
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
