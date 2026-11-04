// Card notifications: new-feedback notices link to their card, and opening or
// moving that card marks the caller's notices about it read.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  addFeedbackMember,
  withOrgHeader,
  createTestProject,
  createTestCard,
  getColumnByName
} from '../helpers'

describe('feedback card notifications', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  async function seedNotice(orgId: string, userId: string, cardId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, app_id, title, link, org_id)
      VALUES (${userId}, 'feedback', 'New bug', ${`/feedback?card=${cardId}`}, ${orgId})
      RETURNING id
    `
    return row!.id
  }

  async function readIds(ids: string[]): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM notifications WHERE id = ANY(${ids}) AND read_at IS NOT NULL
    `
    return rows.map(r => r.id)
  }

  async function setup() {
    const { org, auth, user } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const inbox = await getColumnByName(sql, 'FEEDBACK INBOX')
    const card = { org_id: org.id, project_id: project.id, swimlane_id: project.default_swimlane_id, column_id: inbox.id }
    const cardA = await createTestCard(sql, card)
    const cardB = await createTestCard(sql, card)
    return { org, auth, user, project, cardA, cardB }
  }

  it('a widget submission notifies recipients with a link to the new card', async () => {
    const { org, user, project } = await setup()
    await sql`
      UPDATE projects SET post_meta = ${sql.json({ notify_user_ids: [user.id] })} WHERE id = ${project.id}
    `

    const res = await $fetch<{ id: string }>('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: project.id, problem_description: 'broken', submitter_name: 'Tester', feedback_sub_type: 'bug' }
    })

    const rows = await sql<{ link: string }[]>`
      SELECT link FROM notifications WHERE user_id = ${user.id} AND org_id = ${org.id} AND app_id = 'feedback'
    `
    expect(rows.map(r => r.link)).toEqual([`/feedback?card=${res.id}`])
  })

  it('POST /cards/:id/read marks only the caller\'s notices about that card', async () => {
    const { org, auth, user, cardA, cardB } = await setup()
    const other = await addFeedbackMember(sql, org.id, ['admin'])
    const mineA = await seedNotice(org.id, user.id, cardA.id)
    const mineB = await seedNotice(org.id, user.id, cardB.id)
    const theirsA = await seedNotice(org.id, other.user.id, cardA.id)

    await $fetch(`/api/feedback/cards/${cardA.id}/read`, { method: 'POST', ...withOrgHeader(auth, org.slug) })

    expect(await readIds([mineA, mineB, theirsA])).toEqual([mineA])
  })

  it('moving a card marks the mover\'s notices about it read', async () => {
    const { org, auth, user, project, cardA } = await setup()
    const notice = await seedNotice(org.id, user.id, cardA.id)
    const todo = await getColumnByName(sql, 'TODO')

    await $fetch(`/api/feedback/cards/${cardA.id}/move`, {
      method: 'PATCH',
      body: { column_id: todo.id, swimlane_id: project.default_swimlane_id, project_id: project.id },
      ...withOrgHeader(auth, org.slug)
    })

    expect(await readIds([notice])).toEqual([notice])
  })

  it('editing a card marks the editor\'s notices about it read', async () => {
    const { org, auth, user, cardA } = await setup()
    const notice = await seedNotice(org.id, user.id, cardA.id)

    await $fetch(`/api/feedback/cards/${cardA.id}`, {
      method: 'PATCH',
      body: { title: 'Renamed' },
      ...withOrgHeader(auth, org.slug)
    })

    expect(await readIds([notice])).toEqual([notice])
  })
})
