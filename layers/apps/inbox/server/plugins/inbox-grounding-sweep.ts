import { Cron } from 'croner'
import { inboxWithAdvisoryLock } from '../utils/inbox-org-routing'
import { syncAllInboxGrounding } from '../utils/inbox-grounding-sync'

// Daily grounding sync for every org. Refreshes the AI drafter's reference
// snapshots. Runs on a cron (default 03:00 UTC) plus once ~30s after boot so a
// fresh deploy grounds without waiting for the daily slot. Both go through the
// advisory lock so only one replica syncs at a time.
//
// The lock key is a committed constant, DISTINCT from the send sweep's
// (INBOX_SEND_SWEEP_LOCK_KEY = ...41) and core's 84100723915584200xx family.
const INBOX_GROUNDING_SYNC_LOCK_KEY = '7203914082716530042'

export default defineNitroPlugin(() => {
  if (process.env.NUXT_PREPARE_BUILD || process.env.NITRO_PRESET === 'prepare') return
  // Disabled under tests — grounding refresh is exercised through the manual
  // endpoint, which controls timing deterministically.
  if (process.env.VITEST) return

  const config = useRuntimeConfig()
  const cronExpr = String(config.inboxGroundingSyncCron || '0 3 * * *')

  // Grounding fetches can sit on slow sites, so the lock anchor gets a longer
  // idle allowance than the send sweep's default.
  const run = () =>
    inboxWithAdvisoryLock(INBOX_GROUNDING_SYNC_LOCK_KEY, 'grounding sync', () => syncAllInboxGrounding(), 30 * 60 * 1000)
      .catch(err => console.error('[inbox] grounding sync error:', err))

  new Cron(cronExpr, { protect: true, timezone: 'UTC' }, run)
  setTimeout(run, 30_000)

  console.log(`[inbox] grounding sync started — cron "${cronExpr}" (UTC) + once ~30s after boot`)
})
