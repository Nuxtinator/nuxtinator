import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getRegisteredSetting } from '../../../utils/settings-registry'
import { isSelfRegistrationEnabled, REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../../../utils/registration'
import { getHostGroupMode, GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE } from '../../../utils/groups'

export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return {
    selfRegistration: await isSelfRegistrationEnabled(db),
    groupMode: await getHostGroupMode(db),
    labels: {
      selfRegistration: getRegisteredSetting(REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION)?.label ?? SETTING_SELF_REGISTRATION,
      groupMode: getRegisteredSetting(GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE)?.label ?? SETTING_GROUP_MODE
    }
  }
})
