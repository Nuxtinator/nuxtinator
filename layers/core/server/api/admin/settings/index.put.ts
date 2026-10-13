import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logUpdate } from '../../../utils/activity-logger'
import { clearHostSetting, setHostSetting } from '../../../utils/settings-store'
import { REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../../../utils/registration'

// Host settings. Turning self-registration back on removes the override, since
// on is the default.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const body = await readBody(event)
  if (typeof body?.selfRegistration !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'selfRegistration must be a boolean' })
  }
  const selfRegistration: boolean = body.selfRegistration

  if (selfRegistration) {
    await clearHostSetting(db, REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION)
  } else {
    await setHostSetting(db, REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION, false)
  }

  logUpdate('core_host_settings', `${REGISTRATION_SETTINGS_NAMESPACE}:${SETTING_SELF_REGISTRATION}`, userId, { value: selfRegistration })

  return { selfRegistration }
})
