import { setUploadedAvatar, uploadAvatarFromRequest } from '#core/server/utils/avatar'
import { authorizeMemberEdit, logMemberEvent } from '../../../../../../utils/member-edit'

// Uploads a new avatar (multipart field `file`) for a member of this org.
export default defineEventHandler(async (event) => {
  const targetUserId = await authorizeMemberEdit(event)

  const uploaded = await uploadAvatarFromRequest(event)
  await setUploadedAvatar(targetUserId, uploaded)
  await logMemberEvent(event, 'org_member_avatar_updated', targetUserId)

  return { avatar: uploaded.url }
})
