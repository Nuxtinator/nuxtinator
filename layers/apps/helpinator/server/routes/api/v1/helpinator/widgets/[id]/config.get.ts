// GET /api/v1/helpinator/widgets/:id/config — public. What the embeddable needs
// to render: appearance, and whether chat and handoff are available.
import { helpinatorPublicConfig } from '../../../../../../utils/helpinator-widgets'
import { helpinatorWithWidget } from '../../../../../../utils/helpinator-public'
import { helpinatorAiReady } from '../../../../../../utils/helpinator-bot'
import { helpinatorHandoffAvailable } from '../../../../../../utils/helpinator-conversations'

export default defineEventHandler(async (event) => {
  return await helpinatorWithWidget(event, async (tx, widget) => {
    const aiConfigured = await helpinatorAiReady(tx, widget.chat_model)
    return helpinatorPublicConfig(widget, { aiConfigured, handoffAvailable: await helpinatorHandoffAvailable(tx) })
  })
})
