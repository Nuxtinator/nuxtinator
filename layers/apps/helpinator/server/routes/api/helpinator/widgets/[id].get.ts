// GET /api/helpinator/widgets/:id
import { withOrgPermission } from '#tenant/server'
import { helpinatorGetWidgetOr404 } from '../../../../utils/helpinator-widgets'
import { helpinatorAdminWidget } from '../../../../utils/helpinator-admin'
import { helpinatorChatModelIds } from '../../../../utils/helpinator-bot'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    return helpinatorAdminWidget(await helpinatorGetWidgetOr404(tx, getRouterParam(event, 'id') ?? ''), await helpinatorChatModelIds(tx))
  })
})
