// GET /api/records/names?ids=a,b — the current name and type of each of
// those records the caller may open: { items: [{ id, typeKey, name }] }.
// Records of any type; ids the caller can't open, or that don't exist, are
// left out. For showing a link to a record under its name of the moment.
// Permission: org membership, then each record's own visibility.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { recordsNamesOf } from '#records/server'

const Query = z.object({ ids: z.string().max(4000) })
const uuid = z.string().uuid()

export default defineEventHandler(async (event) => {
  const parsed = Query.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
  }
  const ids = [...new Set(parsed.data.ids.split(',').filter(id => uuid.safeParse(id).success))].slice(0, 100)
  return await withOrgContext(event, async (tx, ctx) => {
    return { items: await recordsNamesOf(tx, ctx, ids) }
  })
})
