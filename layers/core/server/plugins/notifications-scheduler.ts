// Schedules the three global-notification background jobs. See
// `notification-jobs.ts` for what each does.
//
//   immediate sweep — every minute
//   daily digest    — 08:00 server time
//   retention       — 03:00 server time (deletes rows past the 90-day window)
//
// `protect: true` prevents a slow run from overlapping the next tick in this
// process (each callback returns its promise so croner can await it); the
// jobs also take a Postgres advisory lock for cross-replica safety.

import { Cron } from 'croner'
import { runImmediateSweep, runDigest, runRetention } from '#core/server/utils/notification-jobs'

export default defineNitroPlugin(() => {
  // Don't run crons in build / prepare / typecheck contexts.
  if (process.env.NUXT_PREPARE_BUILD || process.env.NITRO_PRESET === 'prepare') return

  new Cron('* * * * *', { protect: true }, () =>
    runImmediateSweep().catch(err => console.error('[notifications] immediate sweep error:', err))
  )

  const digest = new Cron('0 8 * * *', { protect: true }, () =>
    runDigest().catch(err => console.error('[notifications] digest error:', err))
  )

  new Cron('0 3 * * *', { protect: true }, () =>
    runRetention().catch(err => console.error('[notifications] retention error:', err))
  )

  console.log(`[notifications] schedulers started — digest next run ${digest.nextRun()?.toISOString() ?? 'unknown'}`)
})
