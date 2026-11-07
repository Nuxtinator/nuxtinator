// GET /api/records/entries/:type?q=&sort=&dir=&limit=&offset=&filters=<json>
// Lists records of a type through the list engine. `filters` is a
// JSON-encoded object keyed by field key: a bare value filters by equality,
// an object supports { in, contains, gte, lte }.
// Returns { items: RecordSummary[], total } where RecordSummary =
// { id, name, status, updatedAt, createdAt, assignedTo, data } — `data` is
// the record's raw jsonb map so list columns for jsonb fields render without
// per-row requests. Permission: the type evaluator's read answer; without
// its view_all answer only shared or assigned records appear.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { listRecords, requireRecordType, requireTypePermission } from '#records/server'

const Query = z.object({
  q: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  filters: z.string().optional()
})

const Filters = z.record(z.string(), z.unknown())

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey, ctx)

    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }

    let filters: Record<string, unknown> | undefined
    if (parsed.data.filters) {
      let raw: unknown
      try {
        raw = JSON.parse(parsed.data.filters)
      } catch {
        throw createError({ statusCode: 400, statusMessage: 'filters must be a JSON object' })
      }
      const parsedFilters = Filters.safeParse(raw)
      if (!parsedFilters.success) {
        throw createError({ statusCode: 400, statusMessage: 'filters must be a JSON object' })
      }
      filters = parsedFilters.data
    }

    const { items, total } = await listRecords(tx, ctx, typeKey, {
      filters,
      q: parsed.data.q,
      sort: parsed.data.sort,
      dir: parsed.data.dir,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    })

    return {
      items: items.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
        assignedTo: r.assignedTo,
        data: r.data
      })),
      total
    }
  })
})
