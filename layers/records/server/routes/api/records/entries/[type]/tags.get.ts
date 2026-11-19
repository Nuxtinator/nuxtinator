// GET /api/records/entries/:type/tags?field=tags&q=&limit=
// Suggestions for a tags field: the values on the type's records the caller
// can see (same visibility rule as the list), most used first, narrowed to
// those containing q. Returns { tags: string[] }. Permission: the type
// evaluator's read answer.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { listRecordsTagValues, requireRecordType, requireTypePermission } from '#records/server'

const Query = z.object({
  field: z.string().min(1).max(64).default('tags'),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey, ctx)

    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }
    const tags = await listRecordsTagValues(tx, ctx, typeKey, parsed.data.field, {
      q: parsed.data.q,
      limit: parsed.data.limit
    })
    return { tags }
  })
})
