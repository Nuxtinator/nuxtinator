// Cards CRUD: list / create / read / patch / delete. Covers validation,
// permission gating, RLS isolation, and observable side-effects.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  withOrgHeader,
  createTestProject,
  createTestCard,
  getColumnByName
} from '../helpers'

describe('feedback cards CRUD', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  it('GET /api/feedback/cards: 400 when project_id query param missing', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const err = await $fetch('/api/feedback/cards', {
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('GET /api/feedback/cards?project_id=X: returns only that project\'s cards', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const projectA = await createTestProject(sql, { org_id: org.id })
    const projectB = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const cardA = await createTestCard(sql, {
      org_id: org.id,
      project_id: projectA.id,
      swimlane_id: projectA.default_swimlane_id,
      column_id: doing.id
    })
    await createTestCard(sql, {
      org_id: org.id,
      project_id: projectB.id,
      swimlane_id: projectB.default_swimlane_id,
      column_id: doing.id
    })

    const res = await $fetch<Array<{ id: string, project_id: string }>>('/api/feedback/cards', {
      query: { project_id: projectA.id },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.length).toBe(1)
    expect(res[0]!.id).toBe(cardA.id)
  })

  it('POST /api/feedback/cards: creates a card with required fields; row lands in DB', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')

    const res = await $fetch<{ id: string, title: string, post_type: string }>('/api/feedback/cards', {
      method: 'POST',
      body: {
        project_id: project.id,
        swimlane_id: project.default_swimlane_id,
        column_id: doing.id,
        title: 'test-feedback-new-card',
        // A supplied post_type is ignored — the board only creates feedback.
        post_type: 'bug'
      },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.id).toBeDefined()
    expect(res.title).toBe('test-feedback-new-card')
    expect(res.post_type).toBe('feedback')

    const rows = await sql<{ org_id: string, post_type: string }[]>`
      SELECT org_id, post_type FROM cards WHERE id = ${res.id}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.org_id).toBe(org.id)
  })

  it('POST: post_type is forced to feedback regardless of body', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')

    const res = await $fetch<{ post_type: string }>('/api/feedback/cards', {
      method: 'POST',
      body: {
        project_id: project.id,
        swimlane_id: project.default_swimlane_id,
        column_id: doing.id,
        title: 'x',
        post_type: 'something-bogus'
      },
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.post_type).toBe('feedback')
  })

  it('POST: 400 when project_id, swimlane_id, or column_id missing', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])

    const missingProject = await $fetch('/api/feedback/cards', {
      method: 'POST',
      body: { title: 'x' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(missingProject.statusCode).toBe(400)
  })

  it('POST: 401 without auth cookie', async () => {
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const err = await $fetch('/api/feedback/cards', {
      method: 'POST',
      body: { project_id: 'x', swimlane_id: 'y', column_id: 'z', title: 't' },
      headers: { 'x-active-org': org.slug }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('GET /api/feedback/cards/:id: returns the card', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: doing.id,
      title: 'fetchable'
    })

    const res = await $fetch<{ id: string, title: string }>(`/api/feedback/cards/${card.id}`, {
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.id).toBe(card.id)
    expect(res.title).toBe('fetchable')
  })

  it('GET /:id: 404 cross-org', async () => {
    const a = await createFeedbackOrgWith(sql, ['admin'])
    const b = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: b.org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const card = await createTestCard(sql, {
      org_id: b.org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: doing.id
    })

    const err = await $fetch(`/api/feedback/cards/${card.id}`, {
      ...withOrgHeader(a.auth, a.org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('PATCH /:id: updates title / description / is_done', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: doing.id
    })

    const updated = await $fetch<{ id: string, title: string, description: string | null, is_done: boolean }>(
      `/api/feedback/cards/${card.id}`,
      {
        method: 'PATCH',
        body: { title: 'edited', description: 'edited desc', is_done: true },
        ...withOrgHeader(auth, org.slug)
      }
    )
    expect(updated.title).toBe('edited')
    expect(updated.description).toBe('edited desc')
    expect(updated.is_done).toBe(true)
  })

  it('PATCH /:id: 400 when no recognised fields supplied', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: doing.id
    })

    // post_type with an invalid value isn't applied; nothing else supplied.
    const err = await $fetch(`/api/feedback/cards/${card.id}`, {
      method: 'PATCH',
      body: { post_type: 'unknownThing' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('PATCH /:id: 404 when card id does not exist (in this org)', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const err = await $fetch('/api/feedback/cards/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      body: { title: 'x' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('DELETE /:id: removes the card', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: doing.id
    })

    const res = await $fetch<{ success: boolean }>(`/api/feedback/cards/${card.id}`, {
      method: 'DELETE',
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.success).toBe(true)

    const rows = await sql<{ id: string }[]>`SELECT id FROM cards WHERE id = ${card.id}`
    expect(rows.length).toBe(0)
  })

  it('PATCH /:id/move: moves a card to a new column; appends to card_column_history', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const done = await getColumnByName(sql, 'DONE')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: doing.id
    })

    const moved = await $fetch<{ id: string, column_id: string }>(`/api/feedback/cards/${card.id}/move`, {
      method: 'PATCH',
      body: { column_id: done.id },
      ...withOrgHeader(auth, org.slug)
    })
    expect(moved.column_id).toBe(done.id)

    const history = await sql<{ column_id: string }[]>`
      SELECT column_id FROM card_column_history WHERE card_id = ${card.id} ORDER BY moved_at DESC LIMIT 1
    `
    expect(history.length).toBe(1)
    expect(history[0]!.column_id).toBe(done.id)
  })

  it('PATCH /:id/move: cross-project move keeps the card and its attachments', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const projectA = await createTestProject(sql, { org_id: org.id })
    const projectB = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const done = await getColumnByName(sql, 'DONE')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: projectA.id,
      swimlane_id: projectA.default_swimlane_id,
      column_id: doing.id,
      title: 'cross-proj'
    })
    await sql`
      INSERT INTO feedback_attachments (card_id, kind, storage_key, filename, mime_type, size_bytes, org_id)
      VALUES (${card.id}, 'screenshot', 'test/key.png', 'shot.png', 'image/png', 1, ${org.id})
    `

    // The panel sends the card's current swimlane, which belongs to project A.
    const moved = await $fetch<{ id: string, project_id: string, swimlane_id: string, column_id: string }>(
      `/api/feedback/cards/${card.id}/move`,
      {
        method: 'PATCH',
        body: {
          column_id: done.id,
          swimlane_id: projectA.default_swimlane_id,
          project_id: projectB.id
        },
        ...withOrgHeader(auth, org.slug)
      }
    )

    expect(moved).toMatchObject({
      id: card.id,
      project_id: projectB.id,
      swimlane_id: projectB.default_swimlane_id,
      column_id: done.id
    })
    const attachments = await sql`SELECT id FROM feedback_attachments WHERE card_id = ${card.id}`
    expect(attachments.length).toBe(1)
    const history = await sql<{ column_id: string }[]>`SELECT column_id FROM card_column_history WHERE card_id = ${card.id}`
    expect(history.map(h => h.column_id)).toContain(done.id)
  })

  it('PATCH /:id/move: 400 without column_id', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const doing = await getColumnByName(sql, 'DOING')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: doing.id
    })

    const err = await $fetch(`/api/feedback/cards/${card.id}/move`, {
      method: 'PATCH',
      body: {},
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('PATCH /:id/move: 404 when card not found', async () => {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const doing = await getColumnByName(sql, 'DOING')
    const err = await $fetch('/api/feedback/cards/00000000-0000-0000-0000-000000000000/move', {
      method: 'PATCH',
      body: { column_id: doing.id },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})
