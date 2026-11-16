// Test-only trigger for the reminder sweep — the interval is off under VITEST
// so a test can send due reminders on demand. A 404 anywhere else.
import { sendDueRecordsReminders } from '../../../utils/reminders'

export default defineEventHandler(async () => {
  if (!process.env.VITEST) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return { sent: await sendDueRecordsReminders() }
})
