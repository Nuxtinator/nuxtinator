// `#helpinator/inbox` when the inbox layer is NOT loaded. Never imports inbox
// or crm, so the layer builds without them; handoff reports
// unavailable and the widget hides its "still need help?" option.
import { createError } from 'h3'
import type { HelpinatorInboxBridge } from './types'

function unavailable(): never {
  throw createError({ statusCode: 501, statusMessage: 'The inbox is not available on this deployment.' })
}

export const helpinatorInbox: HelpinatorInboxBridge = {
  available: false,
  recordHandoff: async () => unavailable(),
  afterHandoff: async () => {}
}
