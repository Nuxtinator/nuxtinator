// Cross-replica gate for background jobs: only one process per cluster runs a
// given job. Skips (logs and returns) when another session holds the lock.
//
// Session-scoped lock ops must share ONE pinned connection: `db` is a pool,
// and if acquire and unlock ran as independent queries they could land on
// different sessions — the unlock would no-op ("you don't own a lock"
// warning) and the lock would stay held by the acquiring session, silently
// skipping every later run until the pool happens to reuse that session. The
// pinned connection sits idle while fn() runs (fn opens its own transactions
// from the pool); it only anchors the lock.
//
// A crash closes the socket and frees the lock, but an orphaned connection
// doesn't: a dev hot-reload (or a hung fn) leaves the session open and the
// lock held for the life of the process, so every later run skips. The
// anchor's idle_session_timeout makes Postgres drop it once it has sat idle
// for `staleAfterMs`, freeing the lock. Pick a value well past the job's
// normal run time: a run that outlasts it loses the lock mid-run, so another
// replica may start an overlapping run.
import { sql } from 'kysely'
import { db } from '#core/server/utils/database'

export interface AdvisoryLockOptions {
  // Log prefix, e.g. 'inbox' → "[inbox] another replica holds…".
  scope: string
  // Human label for the job, used in the skip log.
  label: string
  // Idle allowance for the lock's anchor connection. Default 5 minutes.
  staleAfterMs?: number
}

export async function withAdvisoryLock(
  // A committed bigint constant, as a decimal string.
  key: string,
  opts: AdvisoryLockOptions,
  fn: () => Promise<void>
): Promise<void> {
  if (!/^-?\d+$/.test(key)) throw new Error(`withAdvisoryLock: invalid key "${key}"`)
  const staleAfterMs = opts.staleAfterMs ?? 5 * 60 * 1000
  await db.connection().execute(async (conn) => {
    const lockRow = await sql<{ got: boolean }>`
      select pg_try_advisory_lock(${sql.raw(key)}::bigint) as got
    `.execute(conn)
    if (!lockRow.rows[0]?.got) {
      console.log(`[${opts.scope}] another replica holds the ${opts.label} lock — skipping`)
      return
    }
    try {
      await sql`select set_config('idle_session_timeout', ${String(staleAfterMs)}, false)`.execute(conn)
      await fn()
    } finally {
      // The session may already be gone (timed out above); its lock went with it.
      await sql`select pg_advisory_unlock(${sql.raw(key)}::bigint), set_config('idle_session_timeout', '0', false)`
        .execute(conn)
        .catch(() => {})
    }
  })
}
