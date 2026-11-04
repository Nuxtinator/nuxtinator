import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { teamVisible } from '#core/server/utils/team-access'
import { getFeedbackTeamScope, withFeedbackProjectTeams } from '../../../../utils/project-teams'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx, ctx) => {
    const scope = await getFeedbackTeamScope(event, tx, ctx)
    const rows = await tx
      .selectFrom('projects')
      .selectAll()
      .where(teamVisible(scope, 'projects'))
      .orderBy(sql`coalesce((post_meta->>'sort_order')::int, 9999)`)
      .orderBy('created_at')
      .execute()
    return await withFeedbackProjectTeams(tx, rows)
  })
})
