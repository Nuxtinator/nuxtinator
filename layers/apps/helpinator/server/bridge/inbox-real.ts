// `#helpinator/inbox` when the inbox layer is loaded: a handoff becomes an
// inbox conversation (source 'helpinator') through inbox's public intake.
import { inboxRecordIntake, inboxAfterIntake, type InboxIntakeResult } from '#inbox/server'
import type { HelpinatorInboxBridge } from './types'

export const helpinatorInbox: HelpinatorInboxBridge = {
  available: true,

  async recordHandoff(tx, input) {
    const intake = await inboxRecordIntake(tx, {
      email: input.email,
      subject: input.subject,
      message: input.transcriptText,
      bodyHtml: input.transcriptHtml,
      source: 'helpinator',
      assignedUserId: input.assignedUserId,
      userAgent: input.userAgent,
      originLabel: 'Help chat handoff'
    })
    return { inboxConversationId: intake.conversationId, intake }
  },

  async afterHandoff(scope, record, opts) {
    await inboxAfterIntake(scope, record.intake as InboxIntakeResult, {
      notify: opts.notify,
      ack: opts.ack
    })
  }
}
