// The app that owns a record type gates its records on the records routes:
// contacts follow the crm app's team list, types without an app follow the
// records app's.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  createTestContact,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
const groupIds: string[] = []

afterEach(async () => {
  if (groupIds.length) await sql`DELETE FROM groups WHERE id IN ${sql(groupIds.splice(0))}`
  await cleanupRecordsTestData(sql)
})

async function limitAppToNewTeam(orgId: string, appId: string, memberIds: string[]): Promise<void> {
  const [group] = await sql<{ id: string }[]>`
    INSERT INTO groups (org_id, name) VALUES (${orgId}, ${`test-records team ${randomUUID().slice(0, 8)}`})
    RETURNING id
  `
  groupIds.push(group!.id)
  for (const userId of memberIds) {
    await sql`INSERT INTO group_members (group_id, user_id) VALUES (${group!.id}, ${userId})`
  }
  await sql`INSERT INTO apps (id) VALUES (${appId}) ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO app_groups (app_id, group_id) VALUES (${appId}, ${group!.id})`
}

describe('record type app gate', () => {
  it('a member off the crm app\'s teams cannot reach contacts through the records routes', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['admin'])
    const outsider = await addRecordsMember(sql, org.id, ['admin'])
    const insiderOpts = withOrgHeader(auth, org.slug)
    const outsiderOpts = withOrgHeader(outsider.auth, org.slug)
    const contact = await createTestContact(sql, { org_id: org.id, created_by: user.id })

    await limitAppToNewTeam(org.id, 'crm', [user.id])

    expect((await $fetch<{ id: string }>(`/api/records/entries/contacts/${contact.id}`, insiderOpts)).id).toBe(contact.id)
    for (const req of [
      () => $fetch(`/api/records/entries/contacts`, outsiderOpts),
      () => $fetch(`/api/records/entries/contacts/${contact.id}`, outsiderOpts),
      () => $fetch(`/api/records/entries/contacts/${contact.id}`, { method: 'PATCH', body: { fields: { name: 'x' } }, ...outsiderOpts }),
      () => $fetch(`/api/records/entries/contacts/${contact.id}`, { method: 'DELETE', ...outsiderOpts })
    ]) {
      await expect(req()).rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('types without an app follow the records app\'s teams', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['admin'])
    const outsider = await addRecordsMember(sql, org.id, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const outsiderOpts = withOrgHeader(outsider.auth, org.slug)
    const task = await $fetch<{ id: string }>('/api/records/entries/task', { method: 'POST', body: { fields: { name: 'test-records gated' } }, ...opts })

    await limitAppToNewTeam(org.id, 'records', [user.id])

    expect((await $fetch<{ id: string }>(`/api/records/entries/task/${task.id}`, opts)).id).toBe(task.id)
    await expect($fetch(`/api/records/entries/task/${task.id}`, outsiderOpts)).rejects.toMatchObject({ statusCode: 403 })
    // Contacts belong to the crm app, which stays open to everyone.
    expect(await $fetch(`/api/records/entries/contacts`, outsiderOpts)).toBeTruthy()
  })
})
