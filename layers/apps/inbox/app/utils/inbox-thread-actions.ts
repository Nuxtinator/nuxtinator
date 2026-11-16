// Client registry of extra "More actions" menu items on a conversation's
// header, exposed to hosts and other layers through the `#inbox` alias.
// Register from a Nuxt app plugin so the registry is filled before the inbox
// renders. The inbox runs no permission check of its own on these: the
// registering layer decides in `visible` and enforces on its own routes.
import type { InboxThread } from '../composables/useInboxThread'
import type { InboxMe } from '../composables/useInboxMe'

export interface InboxThreadActionContext {
  conversation: InboxThread['conversation']
  me: InboxMe | null
  /** Reloads the thread and its "Notes & activity" timeline. */
  refresh: () => Promise<void>
}

export interface InboxThreadAction {
  /** Stable id; registering the same id again replaces the entry. */
  id: string
  label: string
  icon?: string
  /** Ascending order among registered actions (default 100); all follow the built-in items. */
  order?: number
  /** Shown when omitted. */
  visible?: (ctx: InboxThreadActionContext) => boolean
  onSelect: (ctx: InboxThreadActionContext) => void | Promise<void>
}

const _threadActions: InboxThreadAction[] = []

export function registerInboxThreadAction(action: InboxThreadAction): void {
  const i = _threadActions.findIndex(a => a.id === action.id)
  if (i >= 0) _threadActions[i] = action
  else _threadActions.push(action)
}

export function getInboxThreadActions(ctx: InboxThreadActionContext): InboxThreadAction[] {
  return _threadActions
    .filter(a => !a.visible || a.visible(ctx))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}
