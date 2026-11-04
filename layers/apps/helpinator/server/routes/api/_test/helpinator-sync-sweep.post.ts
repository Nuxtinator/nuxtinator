// Test-only trigger for the scheduled library sync — the cron is disabled
// under VITEST so a test can run the sweep on demand. A 404 anywhere else.
import { helpinatorWithSyncLock, helpinatorSyncDueSources } from '../../../utils/helpinator-scheduled-sync'

export default defineEventHandler(async (event) => {
  if (!process.env.VITEST) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  const body = await readBody<{ maxAgeDays?: number }>(event).catch(() => null)
  let started = 0
  await helpinatorWithSyncLock(async () => {
    started = await helpinatorSyncDueSources(body?.maxAgeDays ?? 7)
  })
  return { started }
})
