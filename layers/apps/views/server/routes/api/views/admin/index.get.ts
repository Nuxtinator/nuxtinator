// GET /api/views/admin — every view (any visibility) with owner
// and share count, for the admin governance section: junk cleanup and
// re-owning views whose owner left. Operator-admin only; in multi-tenant
// deploys RLS scopes the listing to the active org.
import { requireOperatorAdmin, withOrgContext } from '#tenant/server'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return await withOrgContext(event, { appId: 'views' }, async (tx) => {
    const rows = await tx
      .selectFrom('views_definitions as v')
      .innerJoin('users as u', 'u.id', 'v.owner_id')
      .leftJoin('views_shares as s', 's.view_id', 'v.id')
      .select(({ fn, selectFrom }) => [
        'v.id', 'v.name', 'v.record_type_key', 'v.visibility',
        'v.owner_id', 'v.updated_at',
        'u.display_name as owner_name',
        fn.count('s.user_id').distinct().as('share_count'),
        selectFrom('views_tabs as t')
          .select('t.layout')
          .whereRef('t.view_id', '=', 'v.id')
          .orderBy('t.position', 'asc')
          .limit(1)
          .as('first_layout')
      ])
      .groupBy(['v.id', 'u.display_name'])
      .orderBy('v.updated_at', 'desc')
      .execute()

    return {
      items: rows.map(row => ({
        id: row.id,
        name: row.name,
        recordTypeKey: row.record_type_key,
        layout: row.first_layout ?? 'table',
        visibility: row.visibility,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        shareCount: Number(row.share_count),
        updatedAt: row.updated_at
      }))
    }
  })
})
