import { isPublicStorageConfigured } from '../../utils/storage'
import { AVATAR_MAX_MB, AVATAR_TYPES, avatarTypesText } from '../../utils/avatar-image'

// What the account page's avatar card can offer.
export default defineEventHandler((event) => {
  requireAuth(event)
  return {
    can_upload: isPublicStorageConfigured(),
    max_mb: AVATAR_MAX_MB,
    types: Object.keys(AVATAR_TYPES),
    types_text: avatarTypesText()
  }
})
