import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logUpdate } from '../../../utils/activity-logger'
import { clearHostSetting, setHostSetting } from '../../../utils/settings-store'
import { REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../../../utils/registration'
import { GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE, setHostGroupMode } from '../../../utils/groups'

// Host settings; the body carries the ones being changed. Turning
// self-registration back on removes the override, since on is the default.
// Switching groups to audiences is refused while content is limited to them.
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const body = await readBody(event)
  const selfRegistration = body?.selfRegistration
  const groupMode = body?.groupMode
  if (selfRegistration !== undefined && typeof selfRegistration !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'selfRegistration must be a boolean' })
  }
  if (groupMode !== undefined && groupMode !== 'audiences' && groupMode !== 'teams') {
    throw createError({ statusCode: 400, statusMessage: 'groupMode must be audiences | teams' })
  }
  if (selfRegistration === undefined && groupMode === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to change' })
  }

  if (selfRegistration !== undefined) {
    if (selfRegistration) {
      await clearHostSetting(db, REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION)
    } else {
      await setHostSetting(db, REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION, false)
    }
    logUpdate('core_host_settings', `${REGISTRATION_SETTINGS_NAMESPACE}:${SETTING_SELF_REGISTRATION}`, userId, { value: selfRegistration })
  }

  if (groupMode !== undefined) {
    await setHostGroupMode(db, groupMode)
    logUpdate('core_host_settings', `${GROUPS_SETTINGS_NAMESPACE}:${SETTING_GROUP_MODE}`, userId, { value: groupMode })
  }

  return { selfRegistration, groupMode }
})
