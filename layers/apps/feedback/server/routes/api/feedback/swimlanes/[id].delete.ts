import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logDelete } from '#core/server/utils/activity-logger'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const swimlane = await tx
      .selectFrom('swimlanes')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    if (!swimlane) throw createError({ statusCode: 404, statusMessage: 'Swimlane not found' })
    if (swimlane.is_default) {
      throw createError({ statusCode: 400, statusMessage: 'Cannot delete default swimlane' })
    }

    const defaultLane = await tx
      .selectFrom('swimlanes')
      .select('id')
      .where('project_id', '=', swimlane.project_id)
      .where('is_default', '=', true)
      .executeTakeFirst()

    if (!defaultLane) {
      throw createError({ statusCode: 500, statusMessage: 'Default swimlane missing for this project' })
    }

    await tx
      .updateTable('cards')
      .set({ swimlane_id: defaultLane.id })
      .where('swimlane_id', '=', id)
      .execute()

    await tx.deleteFrom('swimlanes').where('id', '=', id).execute()

    logDelete('swimlanes', id, ctx.userId, {
      name: swimlane.name,
      migrated_to: defaultLane.id
    })

    return {
      success: true,
      swimlane,
      default_swimlane_id: defaultLane.id
    }
  })
})
