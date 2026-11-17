// GET /api/inbox/me → the caller's own sending identity plus the resolved From
// options the composer offers. inbox.access (one tier below send) so read-only
// agents can still see why no signature attaches to their view.
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.access', async (tx, ctx) => {
    const identity = await inboxGetIdentity(tx, ctx.userId)
    const settings = await getInboxSettings(tx)
    const alias = identity?.alias ?? null
    const user = await tx.selectFrom('users').select('is_admin').where('id', '=', ctx.userId).executeTakeFirst()
    return {
      userId: ctx.userId,
      alias,
      signature: identity?.signature ?? null,
      // Personal From only exists once an alias is set AND the org has a mail
      // domain of its own (not the host's under slug addresses) to host it.
      personalFrom: inboxPersonalFromAddress(alias, settings),
      contactAddress: settings.contactAddress || null,
      // No domain can receive mail for this org yet: replies are held.
      noReceivingDomain: !settings.mailDomain,
      brandFromName: settings.brandFromName || null,
      canManageSettings: ctx.perms.has('inbox.settings.manage'),
      // Host admins set up mail domains under /admin/email.
      isHostAdmin: !!user?.is_admin,
      // Note moderation and suppression clearing stay with the org admin role.
      canModerate: ctx.roles.includes('admin')
    }
  })
})
