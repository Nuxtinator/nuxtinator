import { replaceAvatar } from '#core/server/utils/avatar'
import { authorizeMemberAvatarEdit, logMemberAvatarEvent } from '../../../../../../utils/member-avatar'

// Removes the avatar of a member of this org.
export default defineEventHandler(async (event) => {
  const targetUserId = await authorizeMemberAvatarEdit(event)

  await replaceAvatar(targetUserId, '')
  await logMemberAvatarEvent(event, 'org_member_avatar_removed', targetUserId)

  return { avatar: null }
})
