import { deleteFromS3, isPublicStorageConfigured } from '../../utils/storage'
import { AVATAR_MAX_BYTES, AVATAR_MAX_MB, avatarImageType } from '../../utils/avatar-image'
import { replaceAvatar, uploadAvatar } from '../../utils/avatar'

// Room for the multipart boundaries and headers around the file.
const MULTIPART_OVERHEAD = 16 * 1024

// Uploads a new avatar (multipart field `file`) to public storage.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)

  if (!isPublicStorageConfigured()) {
    throw createError({ statusCode: 501, statusMessage: 'Avatar uploads are not available' })
  }

  // The body is read into memory, so its declared size is checked first.
  const length = Number(getHeader(event, 'content-length'))
  if (!length) {
    throw createError({ statusCode: 411, statusMessage: 'Content-Length is required' })
  }
  if (length > AVATAR_MAX_BYTES + MULTIPART_OVERHEAD) {
    throw createError({ statusCode: 413, statusMessage: `Image too large (max ${AVATAR_MAX_MB} MB)` })
  }

  const parts = await readMultipartFormData(event)
  const file = parts?.find(part => part.name === 'file' && part.filename)
  if (!file) {
    throw createError({ statusCode: 400, statusMessage: 'No image provided' })
  }
  if (file.data.byteLength > AVATAR_MAX_BYTES) {
    throw createError({ statusCode: 413, statusMessage: `Image too large (max ${AVATAR_MAX_MB} MB)` })
  }
  if (!avatarImageType(file.data)) {
    throw createError({ statusCode: 415, statusMessage: 'Use a JPEG, PNG, GIF or WebP image' })
  }

  const uploaded = (await uploadAvatar(file.data))!
  try {
    await replaceAvatar(user.userId, uploaded.url)
  } catch (err) {
    await deleteFromS3(uploaded.key, 'public').catch(() => {})
    throw err
  }

  logEvent({
    eventType: 'PROFILE_AVATAR_UPDATED',
    tableName: 'users',
    recordId: user.userId,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })

  return { avatar: uploaded.url }
})
