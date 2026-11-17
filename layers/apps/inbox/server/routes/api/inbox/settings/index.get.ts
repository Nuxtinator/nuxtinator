// GET /api/inbox/settings — the org's inbox configuration, for holders of
// inbox.settings.manage (the contact-form API key is a server-to-server
// secret). The contact address is derived from the mail domain and is
// read-only here.
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.settings.manage', async (tx) => {
    return inboxSettingsView(await getInboxSettings(tx))
  })
})
