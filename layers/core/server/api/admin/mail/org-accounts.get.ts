import { requireOperatorAdmin } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { getHostSetting } from '#core/server/utils/settings-store'
import { MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_RECEIVE_ACCOUNT, SETTING_MAIL_ORG_SEND_ACCOUNT } from '#core/server/utils/mail-host'

// Which host accounts organizations' own domains are set up on. Null means
// the environment account.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  return {
    sendAccountId: await getHostSetting<string | null>(db, MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_SEND_ACCOUNT),
    receiveAccountId: await getHostSetting<string | null>(db, MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_RECEIVE_ACCOUNT)
  }
})
