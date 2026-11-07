// POST /api/views/:id/tabs — add a tab after the last one. Needs 'edit'.
import { z } from 'zod'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { insertTab, requireView, toTabDetail, VIEWS_LAYOUTS } from '../../../../utils/views'

const Body = z.object({
  name: z.string().trim().max(80).optional(),
  layout: z.enum(VIEWS_LAYOUTS),
  definition: z.unknown().optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    const tab = await insertTab(tx, view, parsed.data)
    await tx.updateTable('views_definitions').set({ updated_at: sql`now()` }).where('id', '=', view.id).execute()
    return toTabDetail(tab)
  })
})
