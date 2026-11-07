// POST /api/records/entries/:type/:id/shares
// Body: { userId, level? } — grants the target user visibility of this
// record; level 'edit' additionally grants record-scoped update capability
// (default 'view'). Upsert: re-sharing with a different level updates the
// existing share; the same level is a no-op. Returns the refreshed share
// list in the same shape as the GET. Permission: the type evaluator's share
// answer plus the record-visibility rule.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { addShare, assertRecordVisible, listShares, requireRecordType, requireTypePermission } from '#records/server'

const Body = z.object({
  userId: z.string().uuid(),
  level: z.enum(['view', 'edit']).optional()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'share')
    await requireRecordType(tx, typeKey, ctx)
    await assertRecordVisible(tx, ctx, typeKey, id)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    await addShare(tx, ctx, id, parsed.data.userId, parsed.data.level ?? 'view')
    return { items: await listShares(tx, id) }
  })
})
