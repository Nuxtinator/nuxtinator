import { Cron } from 'croner'
import { inboxWithAdvisoryLock } from '../utils/inbox-org-routing'
import { inboxRunAutoCloseSweep, INBOX_AUTO_CLOSE_LOCK_KEY } from '../utils/inbox-autoclose'

// Daily auto-close of pending conversations that have gone quiet (see
// inbox-autoclose.ts). Cron from runtimeConfig.inboxAutoCloseCron (default
// 04:00 UTC); the advisory lock keeps it to one replica. Disabled under tests,
// which drive the sweep through the _test endpoint instead.
export default defineNitroPlugin(() => {
  if (process.env.NUXT_PREPARE_BUILD || process.env.NITRO_PRESET === 'prepare') return
  if (process.env.VITEST) return

  const config = useRuntimeConfig()
  const cronExpr = String(config.inboxAutoCloseCron || '0 4 * * *')

  new Cron(cronExpr, { protect: true, timezone: 'UTC' }, () =>
    inboxWithAdvisoryLock(INBOX_AUTO_CLOSE_LOCK_KEY, 'auto-close sweep', async () => { await inboxRunAutoCloseSweep() })
      .catch(err => console.error('[inbox] auto-close sweep error:', err))
  )

  console.log(`[inbox] auto-close sweep started — cron "${cronExpr}" (UTC)`)
})
