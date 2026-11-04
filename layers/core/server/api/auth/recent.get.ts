import { requireRecentAuth } from '../../utils/sessions'

// GET /api/auth/recent — succeeds when the session re-authenticated recently,
// else the 403 `reauth` error that `useReauth()` turns into a prompt. Lets the
// client confirm identity before starting a flow that leaves the page.
export default defineEventHandler(async (event) => {
  await requireRecentAuth(event)
  return { ok: true }
})
