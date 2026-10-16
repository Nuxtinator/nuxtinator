import { replaceAvatar } from '#core/server/utils/avatar'
import { authorizeMemberEdit, logMemberEvent } from '../../../../../../utils/member-edit'

// Removes the avatar of a member of this org.
export default defineEventHandler(async (event) => {
  const targetUserId = await authorizeMemberEdit(event)

  await replaceAvatar(targetUserId, '')
  await logMemberEvent(event, 'org_member_avatar_removed', targetUserId)

  return { avatar: null }
})
