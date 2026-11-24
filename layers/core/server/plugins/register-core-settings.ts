// Core's own entries in the settings registry.
import { registerSetting } from '../utils/settings-registry'
import { REGISTRATION_SETTINGS_NAMESPACE, SETTING_SELF_REGISTRATION } from '../utils/registration'
import { MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_RECEIVE_ACCOUNT, SETTING_MAIL_ORG_SEND_ACCOUNT, parseAccountId } from '../utils/mail-host'
import { GROUPS_SETTINGS_NAMESPACE, SETTING_GROUP_MODE, SETTING_ORG_GROUP_MODE, parseGroupMode, type GroupMode } from '../utils/groups'
import { APP_LAYOUT_NAMESPACE, SETTING_APP_LAYOUT } from '../utils/app-layout'
import { emptyAppLayout, parseAppLayout, type AppLayout } from '../../app/utils/app-layout'

export default defineNitroPlugin(() => {
  // An org's arrangement of its apps (an org setting; the deployment's in single mode).
  registerSetting<AppLayout>({
    namespace: APP_LAYOUT_NAMESPACE,
    key: SETTING_APP_LAYOUT,
    default: emptyAppLayout(),
    parse: parseAppLayout,
    label: 'App arrangement'
  })

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

  // An org's groups (an org setting).
  registerSetting<GroupMode>({
    namespace: GROUPS_SETTINGS_NAMESPACE,
    key: SETTING_ORG_GROUP_MODE,
    default: 'teams',
    parse: parseGroupMode,
    label: 'Org group mode'
  })

  // The host accounts org custom domains are provisioned on; null = the env account.
  registerSetting<string | null>({
    namespace: MAIL_SETTINGS_NAMESPACE,
    key: SETTING_MAIL_ORG_SEND_ACCOUNT,
    default: null,
    parse: parseAccountId,
    label: 'Sending account for organizations\' domains'
  })
  registerSetting<string | null>({
    namespace: MAIL_SETTINGS_NAMESPACE,
    key: SETTING_MAIL_ORG_RECEIVE_ACCOUNT,
    default: null,
    parse: parseAccountId,
    label: 'Receiving account for organizations\' domains'
  })
})
