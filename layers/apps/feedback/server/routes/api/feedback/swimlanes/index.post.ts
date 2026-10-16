import { readBody } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) ?? {}
  const projectId = typeof body.project_id === 'string' ? body.project_id : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const position = typeof body.position === 'number' ? body.position : 999

  if (!projectId) throw createError({ statusCode: 400, statusMessage: 'project_id is required' })
  if (!name) throw createError({ statusCode: 400, statusMessage: 'name is required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const row = await tx
      .insertInto('swimlanes')
      .values({
        project_id: projectId,
        name,
        position,
        is_default: false
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    logCreate('swimlanes', row.id, ctx.userId, { name, project_id: projectId })
    return row
  })
})
