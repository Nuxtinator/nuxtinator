// POST /api/helpinator/widgets — create a widget.
import { withOrgPermission } from '#tenant/server'
import { HelpinatorWidgetInput, helpinatorCreateWidget } from '../../../../utils/helpinator-widgets'
import { helpinatorAdminWidget } from '../../../../utils/helpinator-admin'
import { helpinatorChatModelIds } from '../../../../utils/helpinator-bot'
import { helpinatorAssertCanBind } from '../../../../utils/helpinator-libraries'
import { getTeamScope } from '#core/server/utils/team-access'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx, ctx) => {
    const parsed = HelpinatorWidgetInput.safeParse(await readBody(event))
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid widget', data: parsed.error.flatten() })
    await helpinatorAssertCanBind(tx, ctx, await getTeamScope(event, tx, ctx, 'context'), parsed.data.library_ids)
    return helpinatorAdminWidget(await helpinatorCreateWidget(tx, parsed.data, ctx.userId), await helpinatorChatModelIds(tx))
  })
})
