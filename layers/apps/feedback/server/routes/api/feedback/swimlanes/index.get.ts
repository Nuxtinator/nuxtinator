import { getQuery } from 'h3'
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const projectId = typeof query.project_id === 'string' ? query.project_id : ''

  if (!projectId) {
    throw createError({ statusCode: 400, statusMessage: 'project_id is required' })
  }

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx) => {
    const rows = await tx
      .selectFrom('swimlanes')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('position', 'asc')
      .execute()

    return rows
  })
})
