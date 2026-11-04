// PUT /api/feedback/notify-settings
// Sets the org-wide default notification recipients. Gated by `feedback.write`
// (the same authority that edits a project's own recipient list); the admin
// role holds it via the all-permissions union. In multi-tenant mode the write
// is scoped to the active org by RLS.

import { readBody } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { getSetting, setSetting } from '#core/server/utils/settings-store'
import { logUpdate } from '#core/server/utils/activity-logger'
import { FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY } from '../../../utils/notify-recipients'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) ?? {}

  return withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    // The registered setting's `parse` sanitizes to a deduped user-id list, so
    // a malformed body can't corrupt the stored value.
    await setSetting(tx, FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY, body.user_ids)

    logUpdate('core_settings', `${FEEDBACK_SETTINGS_NAMESPACE}:${DEFAULT_NOTIFY_SETTING_KEY}`, ctx.userId, {
      setting: DEFAULT_NOTIFY_SETTING_KEY
    })

    const userIds = await getSetting<string[]>(tx, FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY)
    return { user_ids: userIds }
  })
})
