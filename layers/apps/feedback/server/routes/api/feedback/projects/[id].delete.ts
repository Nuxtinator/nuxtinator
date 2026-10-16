import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logDelete } from '#core/server/utils/activity-logger'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
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
