/**
 * POST /api/feedback/cards/:id/reply — email the feedback submitter.
 *
 * Sends the member's message to the address the submitter signed in with,
 * quoting their original feedback underneath, and appends the sent reply to
 * the card's `post_meta.replies` so the panel shows what was said.
 */
import { getRouterParam, readBody } from 'h3'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { sendEmail } from '#email'
import { logUpdate } from '#core/server/utils/activity-logger'
import { buildFeedbackReplyEmail } from '../../../../../utils/reply-email'

const MESSAGE_CAP = 10_000
const SUBJECT_CAP = 200

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const body = await readBody(event) ?? {}
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) throw createError({ statusCode: 400, statusMessage: 'message required' })
  if (message.length > MESSAGE_CAP) {
    throw createError({ statusCode: 400, statusMessage: `message exceeds ${MESSAGE_CAP} characters` })
  }
  const subjectIn = typeof body.subject === 'string' ? body.subject.trim().slice(0, SUBJECT_CAP) : ''

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const card = await tx
      .selectFrom('cards')
      .select(['id', 'post_type', 'post_meta'])
      .where('id', '=', id)
      .executeTakeFirst()

    if (!card) throw createError({ statusCode: 404, statusMessage: 'Card not found' })
    if (card.post_type !== 'feedback') {
      throw createError({ statusCode: 400, statusMessage: 'Not a feedback card' })
    }

    const postMeta = (card.post_meta ?? {}) as Record<string, any>
    const to = typeof postMeta.submitter_email === 'string' ? postMeta.submitter_email.trim() : ''
    if (!to) throw createError({ statusCode: 400, statusMessage: 'Submitter has no email address' })

    const sender = await tx
      .selectFrom('users')
      .select(['display_name', 'email'])
      .where('id', '=', ctx.userId)
      .executeTakeFirst()
    const senderName = sender?.display_name || sender?.email || 'The team'

    const config = useRuntimeConfig()
    const appName = String(config.appName || '')
    const subject = subjectIn || 'Re: your feedback'
    const { html, text } = buildFeedbackReplyEmail({ message, senderName, appName, postMeta })

    const sent = await sendEmail({ to, subject, html, text })
    if (!sent) throw createError({ statusCode: 502, statusMessage: 'Email could not be sent' })

    const reply = {
      sent_at: new Date().toISOString(),
      sent_by: ctx.userId,
      sent_by_name: senderName,
      to,
      subject,
      message
    }

    const row = await tx
      .updateTable('cards')
      .set({
        post_meta: sql`jsonb_set(
          post_meta,
          '{replies}',
          (CASE WHEN jsonb_typeof(post_meta->'replies') = 'array' THEN post_meta->'replies' ELSE '[]'::jsonb END)
            || ${JSON.stringify([reply])}::text::jsonb
        )`,
        updated_at: sql`now()`
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()

    logUpdate('cards', id, ctx.userId, { fields: ['post_meta.replies'], reply_to: to })
    return row
  })
})
