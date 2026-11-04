import { db } from '../../utils/database'
import { isSelfRegistrationOpen } from '../../utils/registration'

// Public: whether the auth pages should offer account creation.
export default defineEventHandler(async () => {
  return { open: await isSelfRegistrationOpen(db) }
})
