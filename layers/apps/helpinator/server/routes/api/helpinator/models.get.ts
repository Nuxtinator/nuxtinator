// GET /api/helpinator/models — the widget form's model picker: the chat
// models the org may use, and the one a widget with no model of its own runs
// on ('' when none resolves).
import { withOrgPermission } from '#tenant/server'
import { resolveFeatureModel } from '#ai/server'
import { HELPINATOR_CHAT_FEATURE, helpinatorChatModels } from '../../../utils/helpinator-bot'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    return {
      models: await helpinatorChatModels(tx),
      defaultModel: await resolveFeatureModel(tx, HELPINATOR_CHAT_FEATURE)
    }
  })
})
