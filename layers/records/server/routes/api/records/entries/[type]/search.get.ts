// GET /api/records/entries/:type/search?q=&limit=
// Name typeahead for connection pickers — same visibility rule as the list.
// Returns { items: [{ id, name }] } ordered by name; an empty q returns the
// first page alphabetically. Permission: the type evaluator's read answer.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { listRecords, requireRecordType, requireTypePermission } from '#records/server'

const Query = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey)

    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }

    const q = parsed.data.q?.trim()
    const { items } = await listRecords(tx, ctx, typeKey, {
      filters: q ? { name: { contains: q } } : undefined,
      sort: 'name',
      dir: 'asc',
      limit: parsed.data.limit ?? 10
    })
    return { items: items.map(r => ({ id: r.id, name: r.name })) }
  })
})
