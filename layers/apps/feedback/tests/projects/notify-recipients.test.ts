// Notify lists naming users who no longer exist (or left the org): submissions
// still land, only real users are notified, and removals prune the lists.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  getAuthHeaders,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  createFeedbackUser,
  addFeedbackMember,
  withOrgHeader,
  createTestProject
} from '../helpers'

describe('feedback notify recipients', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  function submit(projectId: string) {
    return $fetch<{ id: string }>('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: projectId, problem_description: 'broken', submitter_name: 'Tester', feedback_sub_type: 'bug' }
    })
  }

  async function setProjectRecipients(projectId: string, ids: string[]) {
    await sql`UPDATE projects SET post_meta = ${sql.json({ notify_user_ids: ids })} WHERE id = ${projectId}`
  }

  async function setDefaultRecipients(orgId: string, ids: string[]) {
    await sql`
      INSERT INTO core_settings (org_id, namespace, key, value)
      VALUES (${orgId}, 'feedback', 'default_notify_user_ids', ${sql.json(ids)})
    `
  }

  async function projectRecipients(projectId: string): Promise<string[]> {
    const [row] = await sql<{ ids: string[] }[]>`SELECT post_meta->'notify_user_ids' AS ids FROM projects WHERE id = ${projectId}`
    return row!.ids
  }

  async function defaultRecipients(orgId: string): Promise<string[] | null> {
    const [row] = await sql<{ value: string[] }[]>`
      SELECT value FROM core_settings
      WHERE org_id = ${orgId} AND namespace = 'feedback' AND key = 'default_notify_user_ids'
    `
    return row?.value ?? null
  }

  async function noticeCount(userId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId} AND app_id = 'feedback'
    `
    return row!.n
  }

  it('a submission skips recipients that no longer exist and notifies the rest', async () => {
    const { org, user } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    await setProjectRecipients(project.id, [randomUUID(), user.id])

    const res = await submit(project.id)

    expect(res.id).toBeTruthy()
    expect(await noticeCount(user.id)).toBe(1)
  })

  it('a project listing only missing users falls back to the default recipients', async () => {
    const { org, user } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    await setProjectRecipients(project.id, [randomUUID()])
    await setDefaultRecipients(org.id, [randomUUID(), user.id])

    const res = await submit(project.id)

    const [card] = await sql`SELECT id FROM cards WHERE id = ${res.id}`
    expect(card).toBeTruthy()
    expect(await noticeCount(user.id)).toBe(1)
  })

  it('deleting a user drops them from project and default notify lists', async () => {
    const { org, user } = await createFeedbackOrgWith(sql, ['admin'])
    const doomed = await addFeedbackMember(sql, org.id, ['member'])
    const project = await createTestProject(sql, { org_id: org.id })
    await setProjectRecipients(project.id, [doomed.user.id, user.id])
    await setDefaultRecipients(org.id, [doomed.user.id])
    const operator = await createFeedbackUser(sql, { is_admin: true })

    await $fetch(`/api/admin/users/${doomed.user.id}`, { method: 'DELETE', ...getAuthHeaders(operator) })

    expect(await projectRecipients(project.id)).toEqual([user.id])
    expect(await defaultRecipients(org.id)).toBeNull()
  })

  it('removing a member drops them from that org\'s notify lists only', async () => {
    const { org, auth, user } = await createFeedbackOrgWith(sql, ['admin'])
    const leaving = await addFeedbackMember(sql, org.id, ['member'])
    const project = await createTestProject(sql, { org_id: org.id })
    await setProjectRecipients(project.id, [leaving.user.id, user.id])
    await setDefaultRecipients(org.id, [user.id, leaving.user.id])

    const other = await createFeedbackOrgWith(sql, ['admin'])
    const otherProject = await createTestProject(sql, { org_id: other.org.id })
    await setProjectRecipients(otherProject.id, [leaving.user.id])

    await $fetch(`/api/o/${org.slug}/members/${leaving.user.id}`, { method: 'DELETE', ...withOrgHeader(auth, org.slug) })

    expect(await projectRecipients(project.id)).toEqual([user.id])
    expect(await defaultRecipients(org.id)).toEqual([user.id])
    expect(await projectRecipients(otherProject.id)).toEqual([leaving.user.id])
  })
})
