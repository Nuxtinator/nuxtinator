// GET /api/records/users?q=&limit=&ids=
// User directory for user_select pickers and assignment filters. In
// multi-tenant mode it lists the active org's members; in single mode all
// users. Returns { items: [{ id, name, email, avatarUrl }] } ordered by
// name. Permission: org membership.
//
// `ids` (comma-separated) resolves named users instead of listing a page of
// the directory: a record can reference anyone in the org, so a caller that
// already holds ids must be able to name them without paging the whole
// membership. Org scoping still applies — ids outside the org resolve to
// nothing.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'

const MAX_IDS = 100

const Query = z.object({
  q: z.string().optional(),
  ids: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }
    const q = parsed.data.q?.trim().toLowerCase() ?? ''
    const limit = parsed.data.limit ?? 20
    const ids = parsed.data.ids
      ? [...new Set(parsed.data.ids.split(',').map(id => id.trim()).filter(Boolean))].slice(0, MAX_IDS)
      : null
    // An explicit lookup of nothing is an empty answer, not the directory.
    if (ids && ids.length === 0) return { items: [] }

    let qb = tx
      .selectFrom('users')
      .select(['users.id', 'users.display_name', 'users.email', 'users.avatar'])

    // Org scoping only exists in multi mode; single mode has no memberships.
    if (ctx.orgId) {
      const orgId = ctx.orgId
      qb = qb.where(eb => eb.exists(
        eb.selectFrom('memberships')
          .select('memberships.user_id')
          .whereRef('memberships.user_id', '=', 'users.id')
          .where('memberships.org_id', '=', orgId)
      ))
    }

    if (ids) qb = qb.where('users.id', 'in', ids)

    if (q) {
      qb = qb.where(eb => eb.or([
        eb(eb.fn('lower', ['users.display_name']), 'like', `%${q}%`),
        eb(eb.fn('lower', ['users.email']), 'like', `%${q}%`)
      ]))
    }

    const rows = await qb
      .orderBy('users.display_name', 'asc')
      .limit(ids ? ids.length : limit)
      .execute()

    return {
      items: rows.map(r => ({
        id: r.id,
        name: r.display_name,
        email: r.email,
        avatarUrl: r.avatar || null
      }))
    }
  })
})
