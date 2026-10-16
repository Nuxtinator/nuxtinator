// POST /api/notifications/read
// Body: { ids?: string[], all?: boolean, links?: string[] }
// Marks the caller's notifications read: by id, all of them, or every one
// whose link is in `links` (the client sends the page it just opened).
// Returns how many changed.

import { z } from 'zod'
import { sql } from 'kysely'
import { withOrgContext } from '#tenant/server'

// `ids` must be non-empty when present so an empty array can't silently fall
// through to a mark-everything. "Mark all" is the explicit `all: true` flag.
const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).optional(),
  all: z.boolean().optional(),
  links: z.array(z.string().min(1).max(2000)).min(1).max(5).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success || (!parsed.data.ids && !parsed.data.all && !parsed.data.links)) {
      throw createError({ statusCode: 400, statusMessage: 'Provide ids or links (non-empty) or all=true.' })
    }

    let qb = tx
      .updateTable('notifications')
      .set({ read_at: sql<Date>`now()` })
      .where('user_id', '=', ctx.userId)
      .where('read_at', 'is', null)

    if (parsed.data.ids) {
      qb = qb.where('id', 'in', parsed.data.ids)
    }
    if (parsed.data.links) {
      qb = qb.where('link', 'in', parsed.data.links)
    }

    const result = await qb.executeTakeFirst()

    return { ok: true, updated: Number(result.numUpdatedRows) }
  })
})
