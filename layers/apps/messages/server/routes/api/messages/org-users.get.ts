// GET /api/messages/org-users?q=
// Lists org members for mention autocomplete. Response includes id, display_name, avatar.
// Requires messages.read.

import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'messages' }, 'messages.read', async (tx, ctx) => {
    const q = getQuery(event)
    const filter = typeof q.q === 'string' ? q.q.trim().toLowerCase() : ''

    let qb = tx
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select(['users.id', 'users.display_name', 'users.avatar', 'users.email'])
      .where('memberships.org_id', '=', ctx.orgId!)
      .orderBy('users.display_name', 'asc')
      .limit(50)

    if (filter) {
      qb = qb.where(eb => eb.or([
        eb(eb.fn('lower', ['users.display_name']), 'like', `%${filter}%`),
        eb(eb.fn('lower', ['users.email']), 'like', `%${filter}%`)
      ]))
    }

    const rows = await qb.execute()
    return {
      users: rows.map(r => ({
        id: r.id,
        display_name: r.display_name,
        avatar: r.avatar
      }))
    }
  })
})
