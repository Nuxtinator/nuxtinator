// Resolves who is notified about new inbox feedback and enqueues the notice.
//
// Recipients come from the project's own `post_meta.notify_user_ids`. A project
// with no list falls back to the org-wide default recipients
// (`feedback:default_notify_user_ids` in the shared settings store); if that's
// empty too, no one is notified.
//
// Delivery is intentionally not handled here. Each recipient gets a core
// notification with `email: 'digest'`, and core's daily digest sweep batches
// them into one email per recipient per day — so a busy inbox never produces a
// ping per card, only a daily summary.

import type { Transaction } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { createNotification } from '#core/server/utils/notifications'
import { getSetting, setSetting, clearSetting } from '#core/server/utils/settings-store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Settings namespace + key for the org-wide default recipient list. Declared in
// code (register-feedback.ts), stored as overrides only.
export const FEEDBACK_SETTINGS_NAMESPACE = 'feedback'
export const DEFAULT_NOTIFY_SETTING_KEY = 'default_notify_user_ids'

// Coerce an arbitrary stored/incoming value into a deduped list of user-id
// strings. Used both as the setting's registered `parse` and to read the
// per-project list.
export function sanitizeNotifyUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
  }
  return out
}

// The notify list for a project: the user ids stored on the project itself.
export function resolveFeedbackNotifyRecipientIds(
  projectPostMeta: Record<string, any> | null | undefined
): string[] {
  return sanitizeNotifyUserIds(projectPostMeta?.notify_user_ids)
}

// A card's notification link. Core's notification rows carry no entity id, so
// the link doubles as the key for marking a card's notices read.
export function feedbackCardLink(cardId: string): string {
  return `/feedback?card=${cardId}`
}

// Mark the user's unread notices about a card read, when they open or change it.
export async function markCardNotificationsRead(
  tx: Transaction<Database>,
  userId: string,
  cardId: string
): Promise<void> {
  await tx
    .updateTable('notifications')
    .set({ read_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .where('app_id', '=', 'feedback')
    .where('link', '=', feedbackCardLink(cardId))
    .where('read_at', 'is', null)
    .execute()
}

export interface NewFeedbackNotice {
  cardId: string
  cardTitle: string
  projectName: string | null
  subType: 'bug' | 'idea'
  /** Who submitted, if signed in — never notified about their own submission. */
  actorId: string | null
  projectPostMeta: Record<string, any> | null | undefined
}

// Enqueue a daily-digest notification to each configured recipient. Writes
// inside the caller's transaction so a successful card insert and its notices
// commit together.
export async function notifyNewFeedbackCard(
  tx: Transaction<Database>,
  notice: NewFeedbackNotice
): Promise<void> {
  // Per-project list wins; if the project hasn't chosen recipients, fall back
  // to the org-wide default from the shared settings store (RLS scopes the read
  // to this card's org inside the caller's transaction).
  let recipientIds = await existingUserIds(tx, resolveFeedbackNotifyRecipientIds(notice.projectPostMeta))
  if (recipientIds.length === 0) {
    recipientIds = await existingUserIds(tx, await getSetting<string[]>(tx, FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY))
  }
  if (recipientIds.length === 0) return

  const label = notice.subType === 'idea' ? 'idea' : 'bug'
  await createNotification(tx, recipientIds.map(userId => ({
    userId,
    appId: 'feedback',
    title: `New ${label}: ${notice.cardTitle}`,
    body: notice.projectName ? `In ${notice.projectName}` : null,
    link: feedbackCardLink(notice.cardId),
    actorId: notice.actorId,
    email: 'digest' as const
  })))
}

// The ids that still belong to a user, in their original order. A list can
// outlive a user it names, and a notification to a missing user fails its FK.
async function existingUserIds(tx: Transaction<Database>, ids: string[]): Promise<string[]> {
  const candidates = ids.filter(id => UUID_RE.test(id))
  if (candidates.length === 0) return []
  const rows = await tx.selectFrom('users').select('id').where('id', 'in', candidates).execute()
  const found = new Set(rows.map(r => r.id))
  return candidates.filter(id => found.has(id))
}

// Drop a user from every notify list visible to `tx`: each project's own list
// and the org-wide default. Run once per org scope when a user is deleted or
// leaves an org.
export async function removeNotifyRecipient(tx: Transaction<Database>, userId: string): Promise<void> {
  await sql`
    UPDATE projects
    SET post_meta = jsonb_set(post_meta, '{notify_user_ids}', (post_meta->'notify_user_ids') - ${userId}::text)
    WHERE jsonb_typeof(post_meta->'notify_user_ids') = 'array'
      AND post_meta->'notify_user_ids' ? ${userId}::text
  `.execute(tx)

  const defaults = await getSetting<string[]>(tx, FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY)
  if (!defaults.includes(userId)) return
  const remaining = defaults.filter(id => id !== userId)
  if (remaining.length === 0) {
    await clearSetting(tx, FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY)
  } else {
    await setSetting(tx, FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY, remaining)
  }
}
