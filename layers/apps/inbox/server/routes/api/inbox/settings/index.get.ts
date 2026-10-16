// GET /api/inbox/settings — the org's inbox configuration, org-admin only
// (the contact-form API key is a server-to-server secret; the same role gate
// as conversation purge). `mailIdentityEditable` says whether the caller may
// change the inbound domain and contact address.
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.access', async (tx, ctx) => {
    if (!ctx.roles.includes('admin')) {
      throw createError({ statusCode: 403, statusMessage: 'Only an admin can view inbox settings' })
    }
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
