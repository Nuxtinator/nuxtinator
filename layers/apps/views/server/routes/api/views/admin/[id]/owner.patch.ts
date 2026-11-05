// PATCH /api/views/admin/:id/owner — reassign a view (typically
// because its owner left). The new owner holds every level; the old owner
// keeps nothing implicit (add a share if they should still see it).
import { z } from 'zod'
import { sql } from 'kysely'
import { requireOperatorAdmin, withOrgContext } from '#tenant/server'

const Body = z.object({
  userId: z.string().uuid()
}).strict()

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const viewId = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'views' }, async (tx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const target = await tx
      .selectFrom('users')
      .select('id')
      .where('id', '=', parsed.data.userId)
      .executeTakeFirst()
    if (!target) throw createError({ statusCode: 404, statusMessage: 'User not found' })

    const updated = await tx
      .updateTable('views_definitions')
      .set({ owner_id: parsed.data.userId, updated_at: sql`now()` })
      .where('id', '=', viewId)
      .executeTakeFirst()
    if (Number(updated.numUpdatedRows) === 0) {
      throw createError({ statusCode: 404, statusMessage: 'View not found' })
    }
    // A share row for the new owner is now redundant.
    await tx
      .deleteFrom('views_shares')
      .where('view_id', '=', viewId)
      .where('user_id', '=', parsed.data.userId)
      .execute()
    return { ok: true }
  })
})
