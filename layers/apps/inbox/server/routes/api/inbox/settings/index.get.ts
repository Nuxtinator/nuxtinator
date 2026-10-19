// GET /api/inbox/settings — the org's inbox configuration, for holders of
// inbox.settings.manage (the contact-form API key is a server-to-server
// secret). `mailIdentityEditable` says whether the caller may change the
// inbound domain and contact address.
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.settings.manage', async (tx, ctx) => {
    const s = await getInboxSettings(tx)
    return {
      inboundDomain: s.inboundDomain,
      contactAddress: s.contactAddress,
      brandFromName: s.brandFromName,
      autoAckEnabled: s.autoAckEnabled,
      contactFormApiKey: s.contactFormApiKey,
      groundingSourceUrls: s.groundingSourceUrls,
      notifyUserIds: s.notifyUserIds,
      autoCloseDays: s.autoCloseDays,
      mailIdentityEditable: await inboxMailIdentityEditable(tx, ctx)
    }
  })
})
