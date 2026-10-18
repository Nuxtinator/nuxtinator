// DELETE /api/list-of-100/contacts/:id
// Hard delete. 404 if the row isn't owned by the caller.

import { withUserPermission } from '#core/server/utils/personal-apps'
import { logDelete } from '#core/server/utils/activity-logger'

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.write', async (tx, ctx) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const result = await tx
      .deleteFrom('list_of_100_contacts')
      .where('id', '=', id)
      .where('user_id', '=', ctx.userId)
      .executeTakeFirst()

    if (!result.numDeletedRows || Number(result.numDeletedRows) === 0) {
      throw createError({ statusCode: 404, statusMessage: 'Contact not found' })
    }
    logDelete('list_of_100_contacts', id, ctx.userId)
    return { ok: true }
  })
})
