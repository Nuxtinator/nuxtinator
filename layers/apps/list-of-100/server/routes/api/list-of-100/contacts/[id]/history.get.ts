// GET /api/list-of-100/contacts/:id/history
// Returns the rhythm timeline for one contact — MARK_CONTACTED / MARK_PRAYED
// events from `activity_logs`. Filtered by the caller's user_id and the
// contact id.

import { withUserPermission } from '#core/server/utils/personal-apps'

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.read', async (tx, ctx) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    // Confirm the contact is the caller's before returning history — prevents
    // a user from probing activity_logs by guessing record ids.
    const owned = await tx
      .selectFrom('list_of_100_contacts')
      .select('id')
      .where('id', '=', id)
      .where('user_id', '=', ctx.userId)
      .executeTakeFirst()
    if (!owned) {
      throw createError({ statusCode: 404, statusMessage: 'Contact not found' })
    }

    const rows = await tx
      .selectFrom('activity_logs')
      .select(['id', 'timestamp', 'event_type', 'metadata'])
      .where('user_id', '=', ctx.userId)
      .where('table_name', '=', 'list_of_100_contacts')
      .where('record_id', '=', id)
      .where('event_type', 'in', ['MARK_CONTACTED', 'MARK_PRAYED'])
      .orderBy('timestamp', 'desc')
      .limit(200)
      .execute()

    return { events: rows }
  })
})
