// Board reads need feedback.read, and every feedback route honours the
// org's app switch.
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

describe('feedback read access', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  async function seedBoard() {
    const { org, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const column = await getColumnByName(sql, 'FEEDBACK INBOX')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: column.id
    })
    const readPaths = [
      '/api/feedback/projects',
      `/api/feedback/projects/${project.id}`,
      `/api/feedback/swimlanes?project_id=${project.id}`,
      `/api/feedback/cards?project_id=${project.id}`,
      `/api/feedback/cards/${card.id}`,
      '/api/feedback/assignees'
    ]
    return { org, auth, readPaths }
  }

  it('a member without feedback.read gets 403 on every board read', async () => {
    const { org, readPaths } = await seedBoard()
    const roleless = await addFeedbackMember(sql, org.id, [])
    const member = await addFeedbackMember(sql, org.id, ['member'])

    for (const path of readPaths) {
      const err = await $fetch(path, withOrgHeader(roleless.auth, org.slug)).catch(e => e)
      expect(err.statusCode, path).toBe(403)
      await $fetch(path, withOrgHeader(member.auth, org.slug))
    }
  })

  it('410 on reads and writes when the feedback app is disabled for the org', async () => {
    const { org, auth, readPaths } = await seedBoard()
    await sql`
      INSERT INTO org_apps (org_id, app_id, enabled, source)
      VALUES (${org.id}, 'feedback', false, 'org_admin')
      ON CONFLICT (org_id, app_id) DO UPDATE SET enabled = excluded.enabled
    `
    for (const path of readPaths) {
      const err = await $fetch(path, withOrgHeader(auth, org.slug)).catch(e => e)
      expect(err.statusCode, path).toBe(410)
    }
    const write = await $fetch('/api/feedback/projects', {
      method: 'POST',
      body: { name: 'blocked' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(write.statusCode).toBe(410)
  })
})
