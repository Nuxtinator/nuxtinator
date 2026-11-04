// `#inbox/server` — the inbox layer's server-side public API, for consumer
// layers (e.g. a future forms layer) that need to open inbox conversations
// without depending on this layer's internal file layout. Lives under
// server/exports/ (not server/utils/) so nitro's auto-import scan doesn't see
// it — re-exporting auto-imported names from their source files would log
// "Duplicated imports".

// Conversation + message creation.
export { inboxCreateConversation, inboxTouchLastMessage } from '../utils/inbox-conversations'
export type { InboxConversationRow } from '../utils/inbox-conversations'
export { inboxCreateMessage } from '../utils/inbox-messages'
export type { InboxMessageRow } from '../utils/inbox-messages'

// Audit + settings + sanitize.
export { inboxLogConversationEvent } from '../utils/inbox-activity'
export { getInboxSettings } from '../utils/inbox-settings'
export type { InboxSettings } from '../utils/inbox-settings'
export { inboxSanitizeEmailHtml } from '../utils/inbox-sanitize'

// Public intake (contact form, help-chat handoff): record in the caller's tx,
// then run the post-commit side effects.
export { inboxRecordIntake, inboxAfterIntake, inboxPlainTextToHtml } from '../utils/inbox-intake'
export type { InboxIntakeInput, InboxIntakeResult, InboxAfterIntakeOptions } from '../utils/inbox-intake'

// Staff notification + courtesy mail.
export { inboxNotifyNewMessage } from '../utils/inbox-notify'
export { inboxSendCourtesy } from '../utils/inbox-courtesy'

// Org-scope plumbing for session-less callers.
export { inboxWithScopeTx, inboxListOrgScopes, inboxResolveOrgForApiKey } from '../utils/inbox-org-routing'

// S3 lifecycle cleanup — for an org-deletion hook to purge inbox objects
// (attachments + raw MIME) before the org's rows cascade away.
export { inboxCollectOrgS3Keys, inboxCollectConversationS3Keys, inboxDeleteS3Keys } from '../utils/inbox-storage-cleanup'
