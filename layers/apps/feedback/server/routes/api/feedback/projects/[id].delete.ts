import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logDelete } from '#core/server/utils/activity-logger'
import { assertFeedbackProjectAccess, getFeedbackTeamScope } from '../../../../utils/project-teams'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const scope = await getFeedbackTeamScope(event, tx, ctx)
    await assertFeedbackProjectAccess(tx, scope, id)

    const deleted = await tx
      .deleteFrom('projects')
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()

    if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Project not found' })

    logDelete('projects', id, ctx.userId, { name: deleted.name })
    return { success: true, project: deleted }
  })
})
