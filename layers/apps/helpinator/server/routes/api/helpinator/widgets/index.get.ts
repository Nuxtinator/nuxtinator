// GET /api/helpinator/widgets — every widget (full config for managers; id +
// name for log readers, who only need the filter).
import { withOrgPermission } from '#tenant/server'
import { helpinatorListWidgets } from '../../../../utils/helpinator-widgets'
import { helpinatorAdminWidget } from '../../../../utils/helpinator-admin'
import { helpinatorChatModelIds } from '../../../../utils/helpinator-bot'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.access', async (tx, ctx) => {
    const widgets = await helpinatorListWidgets(tx)
    if (!ctx.perms.has('helpinator.manage')) return widgets.map(w => ({ id: w.id, name: w.name }))
    const chatModelIds = await helpinatorChatModelIds(tx)
    return widgets.map(w => helpinatorAdminWidget(w, chatModelIds))
  })
})
