// GET /api/records/refs/:source?q=&limit= — targets of a ref source the caller
// can see, for ref pickers. With ?ids=a,b instead, those targets as the
// caller sees them (labels for values already chosen). Returns
// { items: [{ id, label, url?, hidden?, missing? }] }. The source decides
// what the caller may see. Permission: org membership.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { getRecordsRefSource, type RecordsRefValue } from '#records/server'

const Query = z.object({
  q: z.string().max(200).optional(),
  ids: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
})

const uuid = z.string().uuid()

export default defineEventHandler(async (event) => {
  const source = getRecordsRefSource(getRouterParam(event, 'source') ?? '')
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Unknown ref source' })
  const parsed = Query.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
  }
  return await withOrgContext(event, async (tx, ctx) => {
    if (parsed.data.ids !== undefined) {
      const ids = [...new Set(parsed.data.ids.split(',').filter(id => uuid.safeParse(id).success))].slice(0, 50)
      const resolved = ids.length > 0 ? await source.resolve(tx, ctx, ids) : new Map()
      const items: RecordsRefValue[] = ids.map((id) => {
        const target = resolved.get(id)
        if (target === undefined) return { id, label: '', missing: true }
        if (target === 'hidden') return { id, label: '', hidden: true }
        return target.url ? { id, label: target.label, url: target.url } : { id, label: target.label }
      })
      return { items }
    }
    const items = await source.search(tx, ctx, parsed.data.q?.trim() ?? '', parsed.data.limit ?? 20)
    return { items }
  })
})
