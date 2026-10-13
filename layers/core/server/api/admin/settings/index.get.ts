import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { isSelfRegistrationEnabled } from '../../../utils/registration'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return { selfRegistration: await isSelfRegistrationEnabled(db) }
})
