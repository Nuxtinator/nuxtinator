import { Cron } from 'croner'
import { helpinatorWithSyncLock, helpinatorSyncDueSources } from '../utils/helpinator-scheduled-sync'

// Keeps website libraries fresh: re-crawls every source whose last sync is
// older than `helpinatorSyncMaxAgeDays` (default 7 — a weekly re-sync). The
// check runs on a cron (default daily, 02:00 UTC) plus once ~60s after boot,
// so a slot missed during a restart is caught up. Only due sources are
// crawled, so the extra checks cost nothing. The advisory lock keeps it to
// one replica. Set HELPINATOR_SYNC_CRON=off to disable.
export default defineNitroPlugin(() => {
  if (process.env.NUXT_PREPARE_BUILD || process.env.NITRO_PRESET === 'prepare') return
  // Disabled under tests — exercised through the _test trigger instead.
  if (process.env.VITEST) return

  const config = useRuntimeConfig()
  const cronExpr = String(config.helpinatorSyncCron ?? '').trim()
  if (!cronExpr || cronExpr === 'off') {
    console.log('[helpinator] scheduled library sync disabled')
    return
  }
  const maxAgeDays = Math.max(1, Number(config.helpinatorSyncMaxAgeDays) || 7)

  // Returns the promise so croner's `protect` can skip overlapping ticks.
  const run = () =>
    helpinatorWithSyncLock(async () => {
      const started = await helpinatorSyncDueSources(maxAgeDays)
      if (started) console.log(`[helpinator] scheduled sync finished — ${started} source(s) re-crawled`)
    }).catch(err => console.error('[helpinator] scheduled sync error:', err))

  new Cron(cronExpr, { protect: true, timezone: 'UTC' }, run)
  setTimeout(() => void run(), 60_000)

  console.log(`[helpinator] scheduled library sync started — cron "${cronExpr}" (UTC), re-crawls sources older than ${maxAgeDays} day(s)`)
})
