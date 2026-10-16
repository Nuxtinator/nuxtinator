import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx) => {
    return await tx
      .selectFrom('projects')
      .selectAll()
      .orderBy(sql`coalesce((post_meta->>'sort_order')::int, 9999)`)
      .orderBy('created_at')
      .execute()
  })
})
