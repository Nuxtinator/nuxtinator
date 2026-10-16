import { setUploadedAvatar, uploadAvatarFromRequest } from '#core/server/utils/avatar'
import { authorizeMemberAvatarEdit, logMemberAvatarEvent } from '../../../../../../utils/member-avatar'

// Uploads a new avatar (multipart field `file`) for a member of this org.
export default defineEventHandler(async (event) => {
  const targetUserId = await authorizeMemberAvatarEdit(event)

  const uploaded = await uploadAvatarFromRequest(event)
  await setUploadedAvatar(targetUserId, uploaded)
  await logMemberAvatarEvent(event, 'org_member_avatar_updated', targetUserId)

  return { avatar: uploaded.url }
})
