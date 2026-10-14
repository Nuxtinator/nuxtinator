import { deleteStoredAvatar } from '../utils/avatar'

// A deleted user's uploaded avatar is removed from storage once the deletion
// has committed.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('user.deleted', async ({ avatar }) => {
    await deleteStoredAvatar(avatar)
  })
})
