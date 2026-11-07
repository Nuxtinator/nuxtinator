// POST /api/views/:id/copy — a private copy of the view's structure (its
// fields, tabs, columns and filters, no cards), owned by the caller:
// { name? } (default "Copy of <name>"). Anyone who can open the view can
// copy it. Returns the new view's detail.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { copyView, requireView } from '../../../../utils/views'

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse((await readBody(event)) ?? {})
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'view')
    return await copyView(tx, ctx, view, parsed.data.name ?? `Copy of ${view.name}`.slice(0, 120))
  })
})
