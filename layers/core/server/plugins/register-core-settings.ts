// Core's own entries in the settings registry.
import { registerSetting } from '../utils/settings-registry'
import { REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../utils/registration'

export default defineNitroPlugin(() => {
  registerSetting<boolean>({
    namespace: REGISTRATION_SETTINGS_NAMESPACE,
    key: SETTING_SELF_REGISTRATION,
    default: true,
    // A malformed stored value closes registration rather than opening it.
    parse: v => v === true,
    label: 'Allow self-registration'
  })
})
