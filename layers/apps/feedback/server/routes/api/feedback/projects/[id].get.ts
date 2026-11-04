import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx) => {
    const project = await tx
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    if (!project) throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    return project
  })
})
