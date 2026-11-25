// Test-only trigger for the comment draft sweep, so a test can run it on
// demand. A 404 anywhere else.
import { sweepCommentDrafts } from '../../../utils/comments'

export default defineEventHandler(async () => {
  if (!process.env.VITEST) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  await sweepCommentDrafts()
  return { ok: true }
})
