// POST /api/context/suggestions/:id/decide — approve or reject pending
// suggestions in a set: `{ action, suggestion_ids?, note?, content? }`.
// Without `suggestion_ids` the decision covers everything still pending in
// the set. `content` approves one suggestion with the reviewer's edits.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { decideSuggestions, getSuggestionSetOr404 } from '../../../../../utils/suggestions'

const Body = z.object({
  action: z.enum(['approve', 'reject']),
  suggestion_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
  note: z.string().max(2000).optional(),
  content: z.string().optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.suggestion.review', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const decided = await decideSuggestions(tx, id, {
      action: parsed.data.action,
      ids: parsed.data.suggestion_ids,
      note: parsed.data.note,
      content: parsed.data.content
    }, ctx.userId)

    for (const d of decided) {
      logUpdate('context_suggestions', d.id, ctx.userId, {
        action: parsed.data.action,
        portfolio_id: d.portfolio_id,
        key: d.section_key,
        ...(d.version_id ? { version_id: d.version_id } : {})
      })
    }

    return { set: await getSuggestionSetOr404(tx, id, { userId: ctx.userId, isReviewer: true }) }
  })
})
