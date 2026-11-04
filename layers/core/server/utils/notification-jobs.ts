// Background delivery + housekeeping for the global notification store. Three
// jobs, all scheduled by `plugins/notifications-scheduler.ts`:
//
//   immediate sweep — emails `email_mode = 'immediate'` rows promptly (one
//                     email each), then stamps `emailed_at`.
//   daily digest    — rolls each user's pending `email_mode = 'digest'` rows
//                     into one summary email.
//   retention       — deletes rows older than the retention window.
//
// Email delivery is decoupled from the request that wrote the row, so producers
// never touch the mailer. The cost is a small latency on "immediate" (bounded
// by the sweep interval) — acceptable for email.
//
// ## Multi-tenant reads
//
// The notifications table is RLS-protected in multi mode, so a background job
// (which has no request, hence no `app.current_org` GUC) can't read across
// orgs in one query. Each job therefore iterates org scopes, setting the GUC
// per org — mirroring the per-(user,org) scan the messages digest used to do.
// In single-tenant mode there's exactly one scope (`null`) and no GUC.
// Personal-app notifications have no org; in multi mode RLS shows them only
// with `app.current_user` set, so jobs also visit each of their recipients.
//
// This per-org iteration is O(orgs) per sweep; fine at current scale. If the
// org count grows large, replace `listScopes()` with a NOTIFY/LISTEN signal
// or a non-RLS pending-queue table.

import { sql, type Transaction } from 'kysely'
import { db } from '#core/server/utils/database'
import { withAdvisoryLock } from '#core/server/utils/advisory-lock'
import type { Database } from '#core/server/database/schema'
import {
  sendImmediateNotificationEmail,
  sendNotificationDigestEmail,
  type DigestOrgGroup,
  type NotificationEmailRow
} from '#core/server/utils/notification-email'

const RETENTION_DAYS = 90

function isTenancyMode(): boolean {
  try {
    const cfg = useRuntimeConfig()
    const paths = (cfg.tenancyMigrationPaths as string[] | undefined) ?? []
    return paths.length > 0
  } catch {
    return false
  }
}

interface OrgScope {
  id: string
  name: string
  slug: string
}

// One pass of a job: an org (multi mode), a personal-notification recipient
// (multi mode), or everything (single mode: both null, no GUC).
interface JobScope {
  org: OrgScope | null
  userId: string | null
}

// The scopes a job must visit. Personal recipients are those with rows that
// are pending email of `mode`, or older than `before`.
async function listScopes(mode: 'immediate' | 'digest' | null, before: Date | null): Promise<JobScope[]> {
  if (!isTenancyMode()) return [{ org: null, userId: null }]
  // Raw SQL — `orgs` and the recipients function are tenancy-only.
  const orgs = await sql<OrgScope>`select id, name, slug from orgs`.execute(db)
  const users = await sql<{ user_id: string }>`
    select user_id from personal_notification_recipients(${mode}, ${before}) as user_id
  `.execute(db)
  return [
    ...orgs.rows.map(org => ({ org, userId: null })),
    ...users.rows.map(r => ({ org: null, userId: r.user_id }))
  ]
}

async function withScopeTx<T>(
  scope: JobScope,
  fn: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return await db.transaction().execute(async (tx) => {
    if (scope.org) {
      await sql`select set_config('app.current_org', ${scope.org.id}, true)`.execute(tx)
    }
    if (scope.userId) {
      await sql`select set_config('app.current_user', ${scope.userId}, true)`.execute(tx)
    }
    return await fn(tx)
  })
}

// Cross-replica gate: only one process per cluster runs a given job. Rows are
// stamped only after their email goes out, so an overlapping run would send
// duplicates: the idle allowance is generous (a hung or orphaned run blocks
// the job for that long, not for the life of the process).
const LOCK_STALE_AFTER_MS = 30 * 60 * 1000

function withJobLock(key: string, label: string, fn: () => Promise<void>): Promise<void> {
  return withAdvisoryLock(key, { scope: 'notifications', label, staleAfterMs: LOCK_STALE_AFTER_MS }, fn)
}

// Distinct, committed lock keys — don't change without coordinating across
// deployments (a changed key means a different lock during a rolling deploy).
const IMMEDIATE_LOCK_KEY = '8410072391558420017'
const DIGEST_LOCK_KEY = '8410072391558420018'
const RETENTION_LOCK_KEY = '8410072391558420019'

async function selectPending(
  tx: Transaction<Database>,
  mode: 'immediate' | 'digest',
  limit?: number
): Promise<NotificationEmailRow[]> {
  let qb = tx
    .selectFrom('notifications')
    .select(['id', 'user_id', 'app_id', 'title', 'body', 'link'])
    .where('email_mode', '=', mode)
    .where('emailed_at', 'is', null)
    .where('read_at', 'is', null)
    .orderBy('created_at', 'asc')
  if (limit) qb = qb.limit(limit)
  return await qb.execute()
}

async function stampEmailed(scope: JobScope, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await withScopeTx(scope, async (tx) => {
    await tx
      .updateTable('notifications')
      .set({ emailed_at: sql<Date>`now()` })
      .where('id', 'in', ids)
      .execute()
  })
}

export async function runImmediateSweep(): Promise<void> {
  await withJobLock(IMMEDIATE_LOCK_KEY, 'immediate', async () => {
    for (const scope of await listScopes('immediate', null)) {
      let rows: NotificationEmailRow[] = []
      await withScopeTx(scope, async (tx) => {
        rows = await selectPending(tx, 'immediate', 200)
      })
      if (rows.length === 0) continue
      // Send outside the txn so mailer latency doesn't hold a DB connection.
      for (const row of rows) {
        await sendImmediateNotificationEmail(row)
      }
      await stampEmailed(scope, rows.map(r => r.id))
    }
  })
}

export async function runDigest(): Promise<void> {
  await withJobLock(DIGEST_LOCK_KEY, 'digest', async () => {
    // One digest email per user, aggregated across all of that user's orgs
    // and grouped by org inside the email.
    const perUser = new Map<string, DigestOrgGroup[]>()
    const idsByScope: { scope: JobScope, ids: string[] }[] = []

    for (const scope of await listScopes('digest', null)) {
      const org = scope.org
      await withScopeTx(scope, async (tx) => {
        const rows = await selectPending(tx, 'digest')
        const ids: string[] = []
        const byUser = new Map<string, NotificationEmailRow[]>()
        for (const row of rows) {
          const list = byUser.get(row.user_id) ?? []
          list.push(row)
          byUser.set(row.user_id, list)
          ids.push(row.id)
        }
        for (const [userId, userRows] of byUser.entries()) {
          const groups = perUser.get(userId) ?? []
          groups.push({ org: org ? { name: org.name, slug: org.slug } : null, rows: userRows })
          perUser.set(userId, groups)
        }
        if (ids.length > 0) idsByScope.push({ scope, ids })
      })
    }

    let sent = 0
    for (const [userId, groups] of perUser.entries()) {
      await sendNotificationDigestEmail(userId, groups)
      sent++
    }
    for (const { scope, ids } of idsByScope) {
      await stampEmailed(scope, ids)
    }
    console.log(`[notifications] digest sent ${sent} email(s)`)
  })
}

export async function runRetention(): Promise<void> {
  await withJobLock(RETENTION_LOCK_KEY, 'retention', async () => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    for (const scope of await listScopes(null, cutoff)) {
      await withScopeTx(scope, async (tx) => {
        await tx
          .deleteFrom('notifications')
          .where('created_at', '<', cutoff)
          .execute()
      })
    }
  })
}
