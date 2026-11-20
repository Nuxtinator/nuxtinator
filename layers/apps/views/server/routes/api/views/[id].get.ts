// GET /api/views/:id — view meta, its definition, its tabs in order, and the
// caller's access level. On a built-in that stands for a record, each tab
// carries the sort that record keeps (`recordSort`), and `canOrder` says
// whether the caller can change it and the order set by dragging. 404 for
// views the caller cannot reach (existence is not disclosed).
import { withOrgPermission } from '#tenant/server'
import { canOrderRecordsUnder } from '#records/server'
import { loadViewDetail, requireView } from '../../../utils/views'
import { readRecordTabs } from '../../../utils/record-tabs'

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const { view, access, viaShare } = await requireView(tx, ctx, viewId, 'view')
    const detail = await loadViewDetail(tx, view, access, viaShare)
    if (!detail.recordId) return { ...detail, canOrder: false }
    const chosen = await readRecordTabs(tx, view, detail.tabs.map(t => t.id))
    return {
      ...detail,
      canOrder: await canOrderRecordsUnder(tx, ctx, detail.recordId),
      tabs: detail.tabs.map(t => ({ ...t, recordSort: chosen.get(t.id)?.sort ?? null }))
    }
  })
})
