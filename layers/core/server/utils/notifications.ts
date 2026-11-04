// Global notification writer. Any app layer creates notifications by calling
// `createNotification(tx, {...})` from inside its own request transaction —
// never by shipping its own table. The row is a self-contained snapshot:
// finished `title` / `body` / `icon` text plus a naive in-app `link`
// (single-tenant shape, e.g. `/messages/<id>`); the tenant route guard adds
// the `/@<slug>` prefix in the browser, and clicks never cross orgs because the
// feed is active-org scoped by RLS. A personal app's transaction has no org,
// so in multi mode its notifications get no org and show in every org.
//
// Email delivery is decoupled from the write: the row records `email` intent
// and a background sweep does the sending (see `notification-jobs.ts`). That
// keeps "an app gets email for free" true — producers never touch the mailer.

import type { Transaction } from 'kysely'
import { sql } from 'kysely'
import type { Database, NotificationEmailMode } from '#core/server/database/schema'

export interface NewNotification {
  /** Recipient. A row whose recipient equals its actor is silently dropped. */
  userId: string
  /** Owning app id — drives the rail badge grouping and icon fallback. */
  appId: string
  /** Finished headline, e.g. "Sarah mentioned you". */
  title: string
  /** Optional secondary line / excerpt. */
  body?: string | null
  /** Optional icon name; falls back to the app's launcher icon when omitted. */
  icon?: string | null
  /** Naive in-app path to open, e.g. `/messages/<conversationId>`. */
  link: string
  /** Who caused this, if anyone. */
  actorId?: string | null
  /** Delivery intent. Defaults to in-bell only. */
  email?: NotificationEmailMode
}

export async function createNotification(
  tx: Transaction<Database>,
  input: NewNotification | NewNotification[]
): Promise<void> {
  const list = Array.isArray(input) ? input : [input]

  const rows = list
    // Never notify someone about their own action.
    .filter(n => n.userId !== (n.actorId ?? null))
    .map((n) => {
      const mode: NotificationEmailMode = n.email ?? 'none'
      return {
        user_id: n.userId,
        app_id: n.appId,
        title: n.title,
        body: n.body ?? null,
        icon: n.icon ?? null,
        link: n.link,
        actor_id: n.actorId ?? null,
        email_mode: mode,
        // `none` is stamped emailed at write time so it stays out of the
        // pending-email index; immediate/digest stay null until a sweep emails.
        emailed_at: mode === 'none' ? sql<Date>`now()` : null
      }
    })

  if (rows.length === 0) return

  await tx.insertInto('notifications').values(rows).execute()
}
