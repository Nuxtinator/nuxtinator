// DELETE /api/helpinator/widgets/:id — removes the widget AND its conversation log.
import { withOrgPermission } from '#tenant/server'
import { helpinatorDeleteWidget } from '../../../../utils/helpinator-widgets'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    await helpinatorDeleteWidget(tx, getRouterParam(event, 'id') ?? '')
    return { ok: true }
  })
})
