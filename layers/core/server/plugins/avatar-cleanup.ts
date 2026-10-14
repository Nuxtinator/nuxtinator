import { replaceAvatar } from '../utils/avatar'

// A deleted user's uploaded avatar is removed from storage with them.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('user.deleting', async ({ userId }) => {
    await replaceAvatar(userId, '')
  })
})
