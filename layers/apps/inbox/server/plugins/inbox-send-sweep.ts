// Schedules the outbound send sweep (see inbox-send-processor.ts). Cadence
// comes from runtimeConfig.inboxSendSweepSeconds so tests can shrink it.
// `protect: true` prevents same-process overlap; the advisory lock adds
// cross-replica safety.
import { Cron } from 'croner'

export default defineNitroPlugin(() => {
  // Don't run crons in build / prepare / typecheck contexts.
  if (process.env.NUXT_PREPARE_BUILD || process.env.NITRO_PRESET === 'prepare') return

  const config = useRuntimeConfig()
  const seconds = Math.min(Math.max(parseInt(String(config.inboxSendSweepSeconds || '20'), 10) || 20, 2), 300)

  // Return the promise: `protect` only skips overlapping ticks if it can
  // await the run.
  new Cron(`*/${seconds} * * * * *`, { protect: true }, () =>
    inboxWithAdvisoryLock(INBOX_SEND_SWEEP_LOCK_KEY, 'send sweep', () => inboxRunSendSweep())
      .catch(err => console.error('[inbox] send sweep error:', err))
  )

  console.log(`[inbox] send sweep started — every ${seconds}s`)
})
