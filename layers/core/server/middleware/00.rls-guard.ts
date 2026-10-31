// Refuses every request while `db` connects as a role that skips RLS. See
// rls-guard.ts.
import { assertDbEnforcesRls } from '../utils/rls-guard'

export default defineEventHandler(async () => {
  await assertDbEnforcesRls()
})
