// Core's own entries in the settings registry.
import { registerSetting } from '../utils/settings-registry'
import { REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../utils/registration'
import { GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE, parseGroupMode, type GroupMode } from '../utils/groups'

export default defineNitroPlugin(() => {
  registerSetting<boolean>({
    namespace: REGISTRATION_SETTINGS_NAMESPACE,
    key: SETTING_SELF_REGISTRATION,
    default: true,
    // A malformed stored value closes registration rather than opening it.
    parse: v => v === true,
    label: 'Allow self-registration'
  })

  registerSetting<GroupMode>({
    namespace: GROUPS_SETTINGS_NAMESPACE,
    key: SETTING_GROUP_MODE,
    default: 'audiences',
    parse: parseGroupMode,
    label: 'Group mode'
  })
})
