// PUT /api/helpinator/widgets/:id — replace a widget's config. Rebinding it to
// another portfolio ends its open conversations.
import { withOrgPermission } from '#tenant/server'
import { HelpinatorWidgetInput, helpinatorGetWidgetOr404, helpinatorUpdateWidget } from '../../../../utils/helpinator-widgets'
import { helpinatorAssertCanBind } from '../../../../utils/helpinator-libraries'
import { helpinatorAdminWidget } from '../../../../utils/helpinator-admin'
import { helpinatorChatModelIds } from '../../../../utils/helpinator-bot'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx, ctx) => {
    const parsed = HelpinatorWidgetInput.safeParse(await readBody(event))
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid widget', data: parsed.error.flatten() })
    const current = await helpinatorGetWidgetOr404(tx, getRouterParam(event, 'id') ?? '')
    await helpinatorAssertCanBind(tx, ctx, parsed.data.library_ids, current.library_ids)
    return helpinatorAdminWidget(await helpinatorUpdateWidget(tx, getRouterParam(event, 'id') ?? '', parsed.data), await helpinatorChatModelIds(tx))
  })
})
