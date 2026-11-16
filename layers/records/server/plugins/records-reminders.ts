import { sendDueRecordsReminders } from '../utils/reminders'

// Sends due reminders every minute; the sweep's advisory lock keeps it to one replica.
const INTERVAL = 60 * 1000

async function sweep() {
  try {
    await sendDueRecordsReminders()
  } catch (err) {
    console.error('records reminder sweep failed:', err)
  }
}

export default defineNitroPlugin(() => {
  if (process.env.NUXT_PREPARE_BUILD || process.env.NITRO_PRESET === 'prepare') return
  // Under tests the sweep runs through the _test trigger instead.
  if (process.env.VITEST) return
  setTimeout(sweep, 30_000)
  setInterval(sweep, INTERVAL)
})
