// GET /api/list-of-100/contacts
// Returns the current user's contacts + progress counts. Owner-only: filtered
// by `user_id = ctx.userId` inside the handler and by the `user_isolation` RLS
// policy.

import { sql } from 'kysely'
import { withUserPermission } from '#core/server/utils/personal-apps'

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.read', async (tx, ctx) => {
    const contacts = await tx
      .selectFrom('list_of_100_contacts')
      .selectAll()
      .where('user_id', '=', ctx.userId)
      .orderBy('sort_order', 'asc')
      .orderBy('name', 'asc')
      .execute()

    const progressRow = await tx
      .selectFrom('list_of_100_contacts')
      .where('user_id', '=', ctx.userId)
      .select([
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) filter (where last_contacted_at >= now() - interval '30 days')`.as('contacted_last_30d'),
        sql<string>`count(*) filter (where last_prayed_at >= now() - interval '30 days')`.as('prayed_last_30d')
      ])
      .executeTakeFirst()

    return {
      contacts,
      progress: {
        total: Number(progressRow?.total ?? 0),
        contactedLast30d: Number(progressRow?.contacted_last_30d ?? 0),
        prayedLast30d: Number(progressRow?.prayed_last_30d ?? 0)
      }
    }
  })
})
