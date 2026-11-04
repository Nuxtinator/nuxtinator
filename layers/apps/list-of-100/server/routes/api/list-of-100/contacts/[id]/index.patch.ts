// PATCH /api/list-of-100/contacts/:id
// Partial update of a contact's user-editable fields. 404 if the row isn't
// owned by the caller.

import { z } from 'zod'
import { sql } from 'kysely'
import { withUserPermission } from '#core/server/utils/personal-apps'
import { logUpdate } from '#core/server/utils/activity-logger'

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  relationship: z.enum(['family', 'friend', 'coworker', 'neighbor', 'classmate', 'other']).optional(),
  faith_status: z.enum(['believer', 'non_believer', 'unknown']).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  sort_order: z.number().int().optional()
})

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.write', async (tx, ctx) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    if (Object.keys(parsed.data).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const updated = await tx
      .updateTable('list_of_100_contacts')
      .set({ ...parsed.data, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('user_id', '=', ctx.userId)
      .returningAll()
      .executeTakeFirst()

    if (!updated) {
      throw createError({ statusCode: 404, statusMessage: 'Contact not found' })
    }
    logUpdate('list_of_100_contacts', updated.id, ctx.userId, { fields: Object.keys(parsed.data) })
    return { contact: updated }
  })
})
