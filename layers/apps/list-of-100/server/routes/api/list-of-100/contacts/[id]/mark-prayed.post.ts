// POST /api/list-of-100/contacts/:id/mark-prayed
// One-tap action: sets `last_prayed_at = now()`.

import { sql } from 'kysely'
import { withUserPermission } from '#core/server/utils/personal-apps'
import { logEvent } from '#core/server/utils/activity-logger'

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.write', async (tx, ctx) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const updated = await tx
      .updateTable('list_of_100_contacts')
      .set({ last_prayed_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('user_id', '=', ctx.userId)
      .returningAll()
      .executeTakeFirst()

    if (!updated) {
      throw createError({ statusCode: 404, statusMessage: 'Contact not found' })
    }
    // Atomic with the timestamp update — pass tx so both commit together.
    await logEvent({
      eventType: 'MARK_PRAYED',
      tableName: 'list_of_100_contacts',
      recordId: updated.id,
      userId: ctx.userId,
      metadata: { contact_name: updated.name }
    }, tx, { throwOnError: true })
    return { contact: updated }
  })
})
