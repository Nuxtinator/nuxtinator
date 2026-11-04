// Replying to a feedback submitter: the email quotes their original feedback,
// and the sent reply is recorded on the card.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  addFeedbackMember,
  withOrgHeader,
  createTestProject,
  createTestCard,
  getColumnByName,
  waitForMailTo
} from '../helpers'

describe('feedback card reply', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  async function setup(postMeta: Record<string, any>, postType: 'feedback' | 'task' = 'feedback') {
    const { org, auth, user } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const inbox = await getColumnByName(sql, 'FEEDBACK INBOX')
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: inbox.id,
      post_type: postType,
      post_meta: postMeta
    })
    return { org, auth, user, card }
  }

  it('emails the submitter with their original feedback quoted and records the reply', async () => {
    const to = `test-feedback-submitter-${randomUUID().slice(0, 8)}@example.com`
    const { org, auth, user, card } = await setup({
      feedback_sub_type: 'bug',
      problem_description: 'The export button does nothing',
      suggested_fix: 'Make it download a CSV',
      submitter_name: 'Sam',
      submitter_email: to,
      labels: ['ui']
    })

    const updated = await $fetch<{ post_meta: Record<string, any> }>(`/api/feedback/cards/${card.id}/reply`, {
      method: 'POST',
      body: { subject: 'Re: export', message: 'Hi Sam,\n\nFixed in today\'s release.' },
      ...withOrgHeader(auth, org.slug)
    })

    const mail = await waitForMailTo(to)
    expect(mail.subject).toBe('Re: export')
    expect(mail.text).toContain('Fixed in today\'s release.')
    expect(mail.text).toContain('> The export button does nothing')
    expect(mail.text).toContain('> Make it download a CSV')

    expect(updated.post_meta.labels).toEqual(['ui'])
    expect(updated.post_meta.replies).toHaveLength(1)
    expect(updated.post_meta.replies[0]).toMatchObject({
      sent_by: user.id,
      to,
      subject: 'Re: export',
      message: 'Hi Sam,\n\nFixed in today\'s release.'
    })
  })

  it('sends to an address set by the member and saves it on the card', async () => {
    const to = `test-feedback-anon-${randomUUID().slice(0, 8)}@example.com`
    const { org, auth, card } = await setup({ problem_description: 'Search is slow', submitter_name: 'Anon' })

    const updated = await $fetch<{ post_meta: Record<string, any> }>(`/api/feedback/cards/${card.id}/reply`, {
      method: 'POST',
      body: { to, message: 'Thanks, looking into it.' },
      ...withOrgHeader(auth, org.slug)
    })

    const mail = await waitForMailTo(to)
    expect(mail.text).toContain('Thanks, looking into it.')
    expect(updated.post_meta.submitter_email).toBe(to)
    expect(updated.post_meta.replies[0]).toMatchObject({ to })

    const invalid = await $fetch(`/api/feedback/cards/${card.id}/reply`, {
      method: 'POST',
      body: { to: 'not-an-email', message: 'hello' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(invalid.statusCode).toBe(400)
  })

  it('400 when the submitter left no email, or the message is empty', async () => {
    const { org, auth, card } = await setup({ problem_description: 'x', submitter_name: 'Anon' })

    const noEmail = await $fetch(`/api/feedback/cards/${card.id}/reply`, {
      method: 'POST',
      body: { message: 'hello' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(noEmail.statusCode).toBe(400)

    const empty = await $fetch(`/api/feedback/cards/${card.id}/reply`, {
      method: 'POST',
      body: { message: '   ' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(empty.statusCode).toBe(400)
  })

  it('400 for a non-feedback card', async () => {
    const { org, auth, card } = await setup({ submitter_email: 'test-feedback-x@example.com' }, 'task')
    const err = await $fetch(`/api/feedback/cards/${card.id}/reply`, {
      method: 'POST',
      body: { message: 'hello' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('403 without feedback.write', async () => {
    const { org, card } = await setup({ submitter_email: 'test-feedback-y@example.com' })
    const viewer = await addFeedbackMember(sql, org.id, ['viewer'])
    const err = await $fetch(`/api/feedback/cards/${card.id}/reply`, {
      method: 'POST',
      body: { message: 'hello' },
      ...withOrgHeader(viewer.auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(403)
  })
})
