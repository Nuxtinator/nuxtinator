import { readBody } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'

function normDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return null
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event) ?? {}
  const projectId = typeof body.project_id === 'string' ? body.project_id : ''
  const swimlaneId = typeof body.swimlane_id === 'string' ? body.swimlane_id : ''
  const columnId = typeof body.column_id === 'string' ? body.column_id : ''
  const title = typeof body.title === 'string' ? body.title : ''
  // This is the feedback board — every card created here is a feedback card.
  const postType = 'feedback' as const

  if (!projectId) throw createError({ statusCode: 400, statusMessage: 'project_id required' })
  if (!swimlaneId) throw createError({ statusCode: 400, statusMessage: 'swimlane_id required' })
  if (!columnId) throw createError({ statusCode: 400, statusMessage: 'column_id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const row = await tx
      .insertInto('cards')
      .values({
        project_id: projectId,
        swimlane_id: swimlaneId,
        column_id: columnId,
        title,
        post_type: postType,
        description: typeof body.description === 'string' ? body.description : null,
        assignee: typeof body.assignee === 'string' ? body.assignee : null,
        start_date: normDate(body.start_date),
        due_date: normDate(body.due_date),
        priority: typeof body.priority === 'string' ? body.priority : null,
        post_meta: (body.post_meta && typeof body.post_meta === 'object') ? body.post_meta : {}
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    logCreate('cards', row.id, ctx.userId, { title, post_type: postType, project_id: projectId })
    return row
  })
})
