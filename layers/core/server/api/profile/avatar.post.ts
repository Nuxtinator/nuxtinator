import { isPublicStorageConfigured, uploadToS3, validateFileSize } from '../../utils/storage'
import { AVATAR_FOLDER, AVATAR_MAX_MB, AVATAR_TYPES, replaceAvatar } from '../../utils/avatar'

// Uploads a new avatar (multipart field `file`) to public storage.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)

  if (!isPublicStorageConfigured()) {
    throw createError({ statusCode: 501, statusMessage: 'Avatar uploads are not available' })
  }

  const parts = await readMultipartFormData(event)
  const file = parts?.find(part => part.name === 'file' && part.filename)
  if (!file) {
    throw createError({ statusCode: 400, statusMessage: 'No image provided' })
  }
  const contentType = file.type ?? ''
  if (!AVATAR_TYPES.includes(contentType)) {
    throw createError({ statusCode: 415, statusMessage: 'Use a JPEG, PNG, GIF or WebP image' })
  }
  if (!validateFileSize(file.data.byteLength, AVATAR_MAX_MB)) {
    throw createError({ statusCode: 413, statusMessage: `Image too large (max ${AVATAR_MAX_MB} MB)` })
  }

  const ext = contentType.split('/')[1]
  const uploaded = await uploadToS3(Buffer.from(file.data), `avatar.${ext}`, contentType, 'public', AVATAR_FOLDER)
  await replaceAvatar(user.userId, uploaded.url)

  logEvent({
    eventType: 'PROFILE_AVATAR_UPDATED',
    tableName: 'users',
    recordId: user.userId,
    userId: user.userId,
    userAgent: getHeader(event, 'user-agent') || undefined
  })

  return { avatar: uploaded.url }
})
