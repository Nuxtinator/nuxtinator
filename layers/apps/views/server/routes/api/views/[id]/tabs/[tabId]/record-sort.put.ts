// PUT /api/views/:id/tabs/:tabId/record-sort — the sort a built-in board
// keeps for the record it stands for (body `{ sort }`, null to go back to the
// tab's own), seen by everyone who opens that board. Takes edit access to
// the record; stored views change their tabs' sort through the tab instead.
import { withOrgPermission } from '#tenant/server'
import { requireTab, requireView } from '../../../../../../utils/views'
import { setRecordTab } from '../../../../../../utils/record-tabs'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  const tabId = getRouterParam(event, 'tabId')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const body = await readBody(event)
    const { view } = await requireView(tx, ctx, viewId, 'view')
    const tab = await requireTab(tx, view, tabId)
    return await setRecordTab(tx, ctx, view, tab, body)
  })
})
