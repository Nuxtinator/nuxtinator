// POST /api/views/:id/copy — a private copy of the view's structure (its
// fields, tabs, columns and filters, no cards), owned by the caller:
// { name? } (default "Copy of <name>"). Anyone who can open the view can
// copy it; a card's board is copied with the sorts that card keeps. Returns
// the new view's detail.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { copyView, requireView, type ViewTabRow } from '../../../../utils/views'
import { builtInOf } from '../../../../utils/builtin-views'
import { withRecordTab } from '../../../../utils/record-tabs'

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
    const builtIn = builtInOf(view)
    let tabs: ViewTabRow[] | undefined
    if (builtIn?.recordId) {
      tabs = []
      for (const tab of builtIn.tabs) tabs.push(await withRecordTab(tx, view, tab))
    }
    return await copyView(tx, ctx, view, parsed.data.name ?? `Copy of ${view.name}`.slice(0, 120), tabs)
  })
})
