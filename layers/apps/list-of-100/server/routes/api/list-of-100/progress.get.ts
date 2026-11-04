// GET /api/list-of-100/progress
// Standalone progress endpoint — used by widgets that don't want the full
// contact list. Same windowing as the inline `progress` returned by GET
// /api/list-of-100/contacts.

import { sql } from 'kysely'
import { withUserPermission } from '#core/server/utils/personal-apps'

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.read', async (tx, ctx) => {
    const row = await tx
      .selectFrom('list_of_100_contacts')
      .where('user_id', '=', ctx.userId)
      .select([
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) filter (where last_contacted_at >= now() - interval '30 days')`.as('contacted_last_30d'),
        sql<string>`count(*) filter (where last_prayed_at >= now() - interval '30 days')`.as('prayed_last_30d')
      ])
      .executeTakeFirst()

    return {
      total: Number(row?.total ?? 0),
      contactedLast30d: Number(row?.contacted_last_30d ?? 0),
      prayedLast30d: Number(row?.prayed_last_30d ?? 0)
    }
  })
})
