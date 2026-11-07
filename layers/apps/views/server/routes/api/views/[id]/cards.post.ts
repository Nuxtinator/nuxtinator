// POST /api/views/:id/cards — on a hand-picked view, add an existing record
// ({ recordId }) or create one ({ fields }), with optional { tabId,
// columnKey } to land it at the end of that tab's column (a board with its
// own columns) or list. A created record is one of the view's own cards.
// Needs 'edit' on the view (see addViewsCard and createViewsCard for the
// record permissions each takes). Views that show every matching record
// have nothing to add — 400.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireTab, requireView } from '../../../../utils/views'
import { addViewsCard, createViewsCard } from '../../../../utils/placements'

const Placement = {
  tabId: z.string().uuid().optional(),
  columnKey: z.string().min(1).max(80).optional()
}

const Body = z.union([
  z.object({ recordId: z.string().uuid(), ...Placement }).strict(),
  z.object({ fields: z.record(z.string(), z.unknown()), ...Placement }).strict()
])

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { view } = await requireView(tx, ctx, viewId, 'edit')
    const { tabId, columnKey } = parsed.data
    const placement = tabId || columnKey
      ? { tab: await requireTab(tx, view, tabId), columnKey }
      : null
    if ('fields' in parsed.data) {
      return { ok: true, ...await createViewsCard(tx, ctx, view, parsed.data.fields, placement) }
    }
    await addViewsCard(tx, ctx, view, parsed.data.recordId, placement)
    return { ok: true, id: parsed.data.recordId }
  })
})
