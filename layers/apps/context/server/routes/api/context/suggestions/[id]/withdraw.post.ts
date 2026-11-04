// POST /api/context/suggestions/:id/withdraw — the author takes back pending
// suggestions from their own set: `{ suggestion_ids? }`, all pending when
// omitted.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getSuggestionSetOr404, REVIEW_PERMISSION, withdrawSuggestions } from '../../../../../utils/suggestions'

const Body = z.object({
  suggestion_ids: z.array(z.string().uuid()).min(1).max(50).optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    const parsed = Body.safeParse((await readBody(event)) ?? {})
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const withdrawn = await withdrawSuggestions(tx, id, parsed.data.suggestion_ids, ctx.userId)
    for (const sid of withdrawn) {
      logUpdate('context_suggestions', sid, ctx.userId, { action: 'withdraw' })
    }

    return {
      set: await getSuggestionSetOr404(tx, id, { userId: ctx.userId, isReviewer: ctx.perms.has(REVIEW_PERMISSION) })
    }
  })
})
