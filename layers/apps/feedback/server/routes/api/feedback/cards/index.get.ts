import { getQuery } from 'h3'
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const projectId = typeof query.project_id === 'string' ? query.project_id : ''
  const columnId = typeof query.column_id === 'string' ? query.column_id : ''
  const swimlaneId = typeof query.swimlane_id === 'string' ? query.swimlane_id : ''
  const postType = typeof query.post_type === 'string' ? query.post_type : ''

  if (!projectId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'project_id query param is required'
    })
  }

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx) => {
    let q = tx.selectFrom('cards').selectAll()

    q = q.where('project_id', '=', projectId)
    if (columnId) q = q.where('column_id', '=', columnId)
    if (swimlaneId) q = q.where('swimlane_id', '=', swimlaneId)
    if (postType) q = q.where('post_type', '=', postType as any)

    const rows = await q.orderBy('created_at', 'desc').execute()
    return rows
  })
})
