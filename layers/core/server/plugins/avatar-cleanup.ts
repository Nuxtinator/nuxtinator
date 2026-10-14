import { db } from '../utils/database'
import { deleteStoredAvatar } from '../utils/avatar'

// A deleted user's uploaded avatar is removed from storage with them. Errors
// are swallowed so later `user.deleting` handlers still run.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('user.deleting', async ({ userId }) => {
    try {
      const row = await db.selectFrom('users').select('avatar').where('id', '=', userId).executeTakeFirst()
      if (row?.avatar) await deleteStoredAvatar(row.avatar)
    } catch (err) {
      console.warn('[avatar] cleanup on user deletion failed:', (err as Error).message)
    }
  })
})
