// Test-only trigger for the auto-close sweep — the daily cron is disabled
// under VITEST so a test can run the sweep on demand. A 404 anywhere else.
import { inboxRunAutoCloseSweep } from '../../../utils/inbox-autoclose'

export default defineEventHandler(async () => {
  if (!process.env.VITEST) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return { closed: await inboxRunAutoCloseSweep() }
})
