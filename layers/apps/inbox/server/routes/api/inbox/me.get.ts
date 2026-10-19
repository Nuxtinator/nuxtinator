// GET /api/inbox/me → the caller's own sending identity plus the resolved From
// options the composer offers. inbox.access (one tier below send) so read-only
// agents can still see why no signature attaches to their view.
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.access', async (tx, ctx) => {
    const identity = await inboxGetIdentity(tx, ctx.userId)
    const settings = await getInboxSettings(tx)
    const alias = identity?.alias ?? null
    return {
      userId: ctx.userId,
      alias,
      signature: identity?.signature ?? null,
      // Personal From only exists once an alias is set AND the org has an
      // inbound domain other than the shared slug-address domain to host it.
      personalFrom: inboxPersonalFromAddress(alias, settings.inboundDomain),
      contactAddress: settings.contactAddress || null,
      brandFromName: settings.brandFromName || null,
      canManageAliases: ctx.roles.includes('admin')
    }
  })
})
