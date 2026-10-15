// Public widget endpoints under /api/v1/feedback*. These accept cross-origin
// requests, look up the project's org via BYPASSRLS, and run in that
// project's tenant context. Anonymous + authenticated submissions both work.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  createFeedbackUser,
  getAuthHeaders,
  generateScopedTestToken,
  createTestProject,
  createTestCard,
  getColumnByName
} from '../helpers'

describe('public widget endpoints', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  it('GET /api/v1/project/:id: returns {id, name} for a real project (no auth required)', async () => {
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id, name: 'test-feedback-pub' })

    const res = await $fetch<{ id: string, name: string }>(`/api/v1/project/${project.id}`)
    expect(res.id).toBe(project.id)
    expect(res.name).toBe('test-feedback-pub')
  })

  it('GET /api/v1/project/:id: 404 for non-existent UUID', async () => {
    const err = await $fetch(`/api/v1/project/${randomUUID()}`).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('GET /api/v1/project/:id: 404 for malformed (non-UUID) id', async () => {
    const err = await $fetch('/api/v1/project/not-a-uuid').catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('POST /api/v1/feedback: anonymous submitter creates a card in the project\'s org context', async () => {
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })

    const res = await $fetch<{ id: string, status: string, project_id: string }>('/api/v1/feedback', {
      method: 'POST',
      body: {
        project_id: project.id,
        problem_description: 'button is too small',
        suggested_fix: 'make it bigger',
        submitter_name: 'Anonymous Tester',
        feedback_sub_type: 'bug'
      }
    })
    expect(res.id).toBeDefined()
    expect(res.status).toBe('new')
    expect(res.project_id).toBe(project.id)

    // Card landed in the project's org context with post_type='feedback'.
    const rows = await sql<{ org_id: string, post_type: string, column_id: string, post_meta: any }[]>`
      SELECT org_id, post_type, column_id, post_meta FROM cards WHERE id = ${res.id}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.org_id).toBe(org.id)
    expect(rows[0]!.post_type).toBe('feedback')

    // Lands in FEEDBACK INBOX.
    const inbox = await getColumnByName(sql, 'FEEDBACK INBOX')
    expect(rows[0]!.column_id).toBe(inbox.id)

    // post_meta records the anonymous submitter info.
    const meta = rows[0]!.post_meta as Record<string, any>
    expect(meta.submitter_anonymous).toBe(true)
    expect(meta.submitter_user_id).toBeNull()
    expect(meta.submitter_name).toBe('Anonymous Tester')
    expect(meta.feedback_sub_type).toBe('bug')
  })

  it('POST /api/v1/feedback: authenticated submitter tags the card with their user id', async () => {
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    // The submitter is NOT a member of the org (widget audience is public).
    const submitter = await createFeedbackUser(sql, { display_name: 'External Submitter' })
    const auth = getAuthHeaders(submitter)

    const res = await $fetch<{ id: string }>('/api/v1/feedback', {
      method: 'POST',
      body: {
        project_id: project.id,
        problem_description: 'pd',
        suggested_fix: 'sf'
      },
      ...auth
    })

    const rows = await sql<{ post_meta: any }[]>`SELECT post_meta FROM cards WHERE id = ${res.id}`
    const meta = rows[0]!.post_meta as Record<string, any>
    expect(meta.submitter_user_id).toBe(submitter.id)
    expect(meta.submitter_anonymous).toBe(false)
  })

  it('POST /api/v1/feedback: 400 missing project_id / type primary field / submitter_name (anon)', async () => {
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })

    const noProj = await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: { problem_description: 'y', suggested_fix: 'z', submitter_name: 'n' }
    }).catch(e => e)
    expect(noProj.statusCode).toBe(400)

    // A bug requires its problem statement.
    const noProblem = await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: project.id, feedback_sub_type: 'bug', suggested_fix: 'z', submitter_name: 'n' }
    }).catch(e => e)
    expect(noProblem.statusCode).toBe(400)

    // An idea requires the idea itself.
    const noIdea = await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: project.id, feedback_sub_type: 'idea', problem_description: 'y', submitter_name: 'n' }
    }).catch(e => e)
    expect(noIdea.statusCode).toBe(400)

    // Anonymous needs submitter_name.
    const noName = await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: project.id, problem_description: 'y', suggested_fix: 'z' }
    }).catch(e => e)
    expect(noName.statusCode).toBe(400)
  })

  it('POST /api/v1/feedback: 404 for non-existent project_id', async () => {
    const err = await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: {
        project_id: randomUUID(),
        problem_description: 'y',
        suggested_fix: 'z',
        submitter_name: 'a'
      }
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('POST /api/v1/feedback: malformed (non-UUID) project_id → 404', async () => {
    const err = await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: {
        project_id: 'not-a-uuid',
        problem_description: 'y',
        suggested_fix: 'z',
        submitter_name: 'a'
      }
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('GET /api/v1/feedback?project_id=X: returns only the calling user\'s submissions for the project', async () => {
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const inbox = await getColumnByName(sql, 'FEEDBACK INBOX')
    const submitter = await createFeedbackUser(sql)
    const auth = getAuthHeaders(submitter)

    // Seed three cards: two from this submitter, one from someone else.
    await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: inbox.id,
      post_type: 'feedback',
      post_meta: { submitter_user_id: submitter.id, problem_description: 'a' }
    })
    await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: inbox.id,
      post_type: 'feedback',
      post_meta: { submitter_user_id: submitter.id, problem_description: 'b' }
    })
    await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: inbox.id,
      post_type: 'feedback',
      post_meta: { submitter_user_id: randomUUID(), problem_description: 'c' }
    })

    const res = await $fetch<Array<{ id: string, problem_description: string }>>(
      '/api/v1/feedback',
      { query: { project_id: project.id }, ...auth }
    )
    expect(res.length).toBe(2)
    const descs = res.map(r => r.problem_description).sort()
    expect(descs).toEqual(['a', 'b'])
  })

  it('GET /api/v1/feedback: 401 unauthenticated', async () => {
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const err = await $fetch('/api/v1/feedback', { query: { project_id: project.id } }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('GET /api/v1/feedback: 400 missing project_id', async () => {
    const submitter = await createFeedbackUser(sql)
    const auth = getAuthHeaders(submitter)
    const err = await $fetch('/api/v1/feedback', { ...auth }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('POST /api/v1/feedback: accepts Bearer token auth (cross-origin widget flow)', async () => {
    // The widget stores the JWT in localStorage and sends `Authorization: Bearer <jwt>`.
    // The cookie helper uses `Cookie: auth-token=<jwt>` instead; we verify the
    // Bearer code path here.
    const { org } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const submitter = await createFeedbackUser(sql)
    // The widget Bearer path verifies a feedback-scoped token (signScopedToken),
    // not a full session cookie — mint one carrying the matching scope.
    const token = generateScopedTestToken(submitter, 'feedback', { project_id: project.id })

    const res = await $fetch<{ id: string }>('/api/v1/feedback', {
      method: 'POST',
      body: {
        project_id: project.id,
        problem_description: 'pd',
        suggested_fix: 'sf'
      },
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(res.id).toBeDefined()

    const rows = await sql<{ post_meta: any }[]>`SELECT post_meta FROM cards WHERE id = ${res.id}`
    const meta = rows[0]!.post_meta as Record<string, any>
    expect(meta.submitter_user_id).toBe(submitter.id)
  })
})
