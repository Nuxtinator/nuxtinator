// Core's own entries in the settings registry.
import { registerSetting } from '../utils/settings-registry'
import { REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../utils/registration'

export default defineNitroPlugin(() => {
  registerSetting<boolean>({
    namespace: REGISTRATION_SETTINGS_NAMESPACE,
    key: SETTING_SELF_REGISTRATION,
    default: true,
    parse: v => (typeof v === 'boolean' ? v : true),
    label: 'Allow self-registration'
  })
})
