import { getRouterParam, readBody } from 'h3'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { markCardNotificationsRead } from '../../../../../utils/notify-recipients'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const body = await readBody(event) ?? {}
  const columnId = typeof body.column_id === 'string' ? body.column_id : ''
  const swimlaneId = typeof body.swimlane_id === 'string' ? body.swimlane_id : ''
  const targetProjectId = typeof body.project_id === 'string' ? body.project_id : null

  if (!columnId) {
    throw createError({ statusCode: 400, statusMessage: 'column_id is required' })
  }

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const card = await tx
      .selectFrom('cards')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    if (!card) throw createError({ statusCode: 404, statusMessage: 'Card not found' })

    await markCardNotificationsRead(tx, ctx.userId, id)

    const isCrossProject = targetProjectId !== null && targetProjectId !== card.project_id

    const updates: Record<string, any> = {
      column_id: columnId,
      last_moved_at: sql`now()`,
      updated_at: sql`now()`
    }
    if (swimlaneId) updates.swimlane_id = swimlaneId

    // Moving to another project keeps the card's id, so its attachments,
    // history and notification links follow it. The card lands in the given
    // swimlane when that belongs to the target project, else the target's
    // default swimlane. RLS keeps the target project inside the org.
    if (isCrossProject) {
      const lanes = await tx
        .selectFrom('swimlanes')
        .select(['id', 'is_default'])
        .where('project_id', '=', targetProjectId)
        .execute()
      if (lanes.length === 0) throw createError({ statusCode: 404, statusMessage: 'Project not found' })
      const lane = lanes.find(l => l.id === swimlaneId) ?? lanes.find(l => l.is_default) ?? lanes[0]!
      updates.project_id = targetProjectId
      updates.swimlane_id = lane.id
    }

    const updated = await tx
      .updateTable('cards')
      .set(updates)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()

    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Card not found' })

    await tx
      .insertInto('card_column_history')
      .values({ card_id: id, column_id: columnId })
      .execute()

    logUpdate('cards', id, ctx.userId, isCrossProject
      ? {
          cross_project: true,
          from_project_id: card.project_id,
          to_project_id: targetProjectId,
          from_column_id: card.column_id,
          to_column_id: columnId
        }
      : { moved_to_column: columnId, moved_to_swimlane: swimlaneId || null })
    return updated
  })
})
