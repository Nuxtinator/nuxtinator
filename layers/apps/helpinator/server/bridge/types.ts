// Shared shape of the `#helpinator/inbox` bridge. Both implementations
// (inbox-real.ts when the inbox layer is loaded, inbox-stub.ts otherwise)
// satisfy this, so helpinator code imports one interface either way.
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'

export interface HelpinatorHandoffInput {
  email: string
  subject: string
  // Plain-text transcript (the inbox message's text body).
  transcriptText: string
  // Escaped HTML transcript (the inbox message's HTML body + the ack appendix).
  transcriptHtml: string
  // A visitor handoff leaves it unassigned (unassigned = needs dispatch).
  assignedUserId: string | null
  userAgent: string | null
}

export interface HelpinatorHandoffRecord {
  inboxConversationId: string
  // Opaque — passed back to `afterHandoff` untouched.
  intake: unknown
}

export interface HelpinatorAfterHandoffOptions {
  notify: boolean
  ack: boolean
}

export interface HelpinatorInboxBridge {
  available: boolean
  recordHandoff: (tx: Transaction<Database>, input: HelpinatorHandoffInput) => Promise<HelpinatorHandoffRecord>
  afterHandoff: (scope: string | null, record: HelpinatorHandoffRecord, opts: HelpinatorAfterHandoffOptions) => Promise<void>
}
