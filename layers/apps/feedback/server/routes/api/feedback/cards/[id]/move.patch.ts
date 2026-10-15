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

    if (!isCrossProject) {
      const updates: Record<string, any> = {
        column_id: columnId,
        last_moved_at: sql`now()`,
        updated_at: sql`now()`
      }
      if (swimlaneId) updates.swimlane_id = swimlaneId

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

      logUpdate('cards', id, ctx.userId, { moved_to_column: columnId, moved_to_swimlane: swimlaneId || null })
      return updated
    }

    // Cross-project move (within the same org — RLS prevents reaching into a different org).
    const inserted = await tx
      .insertInto('cards')
      .values({
        project_id: targetProjectId,
        swimlane_id: swimlaneId || card.swimlane_id,
        column_id: columnId,
        title: card.title,
        description: card.description,
        post_type: card.post_type,
        post_meta: card.post_meta,
        assignee: card.assignee,
        priority: card.priority,
        start_date: card.start_date as string | null | undefined,
        due_date: card.due_date as string | null | undefined,
        is_done: card.is_done,
        testing_results: card.testing_results
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await tx
      .insertInto('card_column_history')
      .values({ card_id: inserted.id, column_id: columnId })
      .execute()

    await tx.deleteFrom('cards').where('id', '=', id).execute()

    logUpdate('cards', inserted.id, ctx.userId, {
      cross_project: true,
      old_card_id: id,
      from_project_id: card.project_id,
      to_project_id: targetProjectId,
      from_column_id: card.column_id,
      to_column_id: columnId
    })

    return inserted
  })
})
