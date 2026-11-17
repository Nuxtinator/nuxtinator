import { z } from 'zod'
import { requireOperatorAdmin } from '#tenant/server'
import { db } from '#core/server/utils/database'
import { clearHostSetting, getHostSetting, setHostSetting } from '#core/server/utils/settings-store'
import { MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_RECEIVE_ACCOUNT, SETTING_MAIL_ORG_SEND_ACCOUNT } from '#core/server/utils/mail-host'

const body = z.object({
  sendAccountId: z.string().uuid().nullable().optional(),
  receiveAccountId: z.string().uuid().nullable().optional()
})

// Null clears the override, so the environment account applies again.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const input = body.parse(await readBody(event))
  for (const [key, value] of [[SETTING_MAIL_ORG_SEND_ACCOUNT, input.sendAccountId], [SETTING_MAIL_ORG_RECEIVE_ACCOUNT, input.receiveAccountId]] as const) {
    if (value === undefined) continue
    if (value === null) {
      await clearHostSetting(db, MAIL_SETTINGS_NAMESPACE, key)
      continue
    }
    const account = await db.selectFrom('mail_accounts').select(['id', 'org_id']).where('id', '=', value).executeTakeFirst()
    if (!account || account.org_id !== null) throw createError({ statusCode: 422, statusMessage: 'Choose one of the host\'s accounts' })
    await setHostSetting(db, MAIL_SETTINGS_NAMESPACE, key, value)
  }
  return {
    sendAccountId: await getHostSetting<string | null>(db, MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_SEND_ACCOUNT),
    receiveAccountId: await getHostSetting<string | null>(db, MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_RECEIVE_ACCOUNT)
  }
})
