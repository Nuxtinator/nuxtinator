// The auto-close sweep body (scheduled daily by plugins/inbox-autoclose-sweep.ts).
// Per org scope: read the quiet threshold (0 = off), close every pending
// conversation whose last message is older than it, and record each close in
// the conversation's activity trail as a system event. A contact reply reopens
// a closed thread, so an expired conversation is never lost — only tidied.
import { inboxListOrgScopes, inboxWithScopeTx } from './inbox-org-routing'
import { getInboxSettings } from './inbox-settings'
import { inboxAutoCloseStalePending } from './inbox-conversations'
import { inboxLogConversationEvent } from './inbox-activity'

// Cross-replica lock key — distinct from the send sweep (...41) and the
// grounding sync (...42).
export const INBOX_AUTO_CLOSE_LOCK_KEY = '7203914082716530043'

export async function inboxRunAutoCloseSweep(): Promise<number> {
  let total = 0
  for (const orgId of await inboxListOrgScopes()) {
    const closed = await inboxWithScopeTx(orgId, async (tx) => {
      const { autoCloseDays } = await getInboxSettings(tx)
      if (autoCloseDays <= 0) return 0
      const ids = await inboxAutoCloseStalePending(tx, autoCloseDays)
      for (const id of ids) {
        await inboxLogConversationEvent(
          tx, id, 'inbox_status_changed',
          `Status → closed (auto: no reply for ${autoCloseDays} days)`,
          { extra: { from: 'pending', to: 'closed', auto: true, quietDays: autoCloseDays } }
        )
      }
      return ids.length
    })
    if (closed > 0) {
      console.log(`[inbox] auto-close: ${closed} pending conversation(s) closed for org ${orgId ?? 'single-tenant'}`)
    }
    total += closed
  }
  return total
}
