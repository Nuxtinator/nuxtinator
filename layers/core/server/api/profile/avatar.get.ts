import { isPublicStorageConfigured } from '../../utils/storage'

// Whether the account page can offer avatar uploads.
export default defineEventHandler((event) => {
  requireAuth(event)
  return { can_upload: isPublicStorageConfigured() }
})
