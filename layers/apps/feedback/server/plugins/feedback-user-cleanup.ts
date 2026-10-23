import { listOrgScopes, withOrgScope } from '#tenant/server'
import { removeNotifyRecipient } from '../utils/notify-recipients'

// Keeps notify lists to people who can still receive them: a deleted user is
// dropped from every org's lists, a user leaving an org from that org's.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('user.deleted', async ({ userId }) => {
    for (const orgId of await listOrgScopes()) {
      try {
        await withOrgScope(orgId, tx => removeNotifyRecipient(tx, userId))
      } catch (err) {
        console.error(`[feedback] notify-list cleanup for user ${userId} in org ${orgId} failed:`, err)
      }
    }
  })

  nitroApp.hooks.hook('membership.deleted', async ({ userId, orgId }) => {
    await withOrgScope(orgId, tx => removeNotifyRecipient(tx, userId))
  })
})
