import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getRegisteredSetting } from '../../../utils/settings-registry'
import { isSelfRegistrationEnabled, REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../../../utils/registration'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return {
    selfRegistration: await isSelfRegistrationEnabled(db),
    labels: {
      selfRegistration: getRegisteredSetting(REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION)?.label ?? SETTING_SELF_REGISTRATION
    }
  }
})
