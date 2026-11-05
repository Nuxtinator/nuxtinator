// POST /api/views/:id/shares — add or re-level a share
// ({ userId, level }). Owner or 'edit' manage shares. Sharing to the owner
// is meaningless and rejected. A share applies whatever the view's
// visibility.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireView } from '../../../../utils/views'

const Body = z.object({
  userId: z.string().uuid(),
  level: z.enum(['view', 'edit'])
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { userId, level } = parsed.data

    const { view } = await requireView(tx, ctx, viewId, 'edit')
    if (userId === view.owner_id) {
      throw createError({ statusCode: 400, statusMessage: 'The owner already holds every level' })
    }
    const target = await tx
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst()
    if (!target) throw createError({ statusCode: 404, statusMessage: 'User not found' })

    await tx
      .insertInto('views_shares')
      .values({ view_id: viewId, user_id: userId, level })
      .onConflict(oc => oc.columns(['view_id', 'user_id']).doUpdateSet({ level }))
      .execute()

    return { ok: true }
  })
})
