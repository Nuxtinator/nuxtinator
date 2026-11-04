// GET /api/helpinator/status — what the admin UI can offer on this deployment.
import { withOrgPermission } from '#tenant/server'
import { helpinatorAiReady } from '../../../utils/helpinator-bot'
import { HELPINATOR_DEFAULT_APPEARANCE } from '../../../utils/helpinator-widgets'
import { helpinatorHandoffAvailable } from '../../../utils/helpinator-conversations'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.access', async (tx, ctx) => {
    return {
      aiConfigured: await helpinatorAiReady(tx),
      inboxAvailable: await helpinatorHandoffAvailable(tx),
      canManage: ctx.perms.has('helpinator.manage'),
      // The widget form starts from these; it saves only what differs.
      appearanceDefaults: HELPINATOR_DEFAULT_APPEARANCE
    }
  })
})
