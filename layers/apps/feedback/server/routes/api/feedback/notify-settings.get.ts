// GET /api/feedback/notify-settings
// The org-wide default notification recipients — the fallback list used when a
// project hasn't chosen its own. Reads the shared settings store; in
// multi-tenant mode the value is scoped to the active org by RLS.

import { withOrgPermission } from '#tenant/server'
import { getSetting } from '#core/server/utils/settings-store'
import { FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY } from '../../../utils/notify-recipients'

export default defineEventHandler(event =>
  withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx) => {
    const userIds = await getSetting<string[]>(tx, FEEDBACK_SETTINGS_NAMESPACE, DEFAULT_NOTIFY_SETTING_KEY)
    return { user_ids: userIds }
  })
)
