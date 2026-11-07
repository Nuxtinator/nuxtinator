// The user directory behind user pickers opens only to callers who can read
// some record type whose app is open to them.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
const groupIds: string[] = []

afterEach(async () => {
  if (groupIds.length) await sql`DELETE FROM groups WHERE id IN ${sql(groupIds.splice(0))}`
  await cleanupRecordsTestData(sql)
})

async function limitAppsToNewTeam(orgId: string, appIds: string[], memberIds: string[]): Promise<void> {
  const [group] = await sql<{ id: string }[]>`
    INSERT INTO groups (org_id, name) VALUES (${orgId}, ${`test-records team ${randomUUID().slice(0, 8)}`})
    RETURNING id
  `
  groupIds.push(group!.id)
  for (const userId of memberIds) {
    await sql`INSERT INTO group_members (group_id, user_id) VALUES (${group!.id}, ${userId})`
  }
  for (const appId of appIds) {
    await sql`INSERT INTO apps (id) VALUES (${appId}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_groups (app_id, group_id) VALUES (${appId}, ${group!.id})`
  }
}

describe('user directory', () => {
  it('lists the org\'s members to a caller who can read records', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])
    const res = await $fetch<{ items: Array<{ id: string }> }>('/api/records/users', withOrgHeader(member.auth, org.slug))
    expect(res.items.map(i => i.id)).toEqual(expect.arrayContaining([user.id, member.user.id]))
  })

  it('refuses a member whose roles read no record type', async () => {
    const { org } = await createRecordsOrgWith(sql, ['admin'])
    const nobody = await addRecordsMember(sql, org.id, ['test-records-no-grants'])
    await expect($fetch('/api/records/users', withOrgHeader(nobody.auth, org.slug)))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses a member off the teams of every app that owns a record type', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['admin'])
    const outsider = await addRecordsMember(sql, org.id, ['member'])
    await limitAppsToNewTeam(org.id, ['records', 'crm'], [user.id])

    expect(await $fetch('/api/records/users', withOrgHeader(auth, org.slug))).toBeTruthy()
    await expect($fetch('/api/records/users', withOrgHeader(outsider.auth, org.slug)))
      .rejects.toMatchObject({ statusCode: 403 })
  })
})
