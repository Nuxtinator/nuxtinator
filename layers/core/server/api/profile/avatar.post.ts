import { deleteFromS3, isPublicStorageConfigured } from '../../utils/storage'
import { AVATAR_MAX_BYTES, AVATAR_MAX_MB, avatarTypesText } from '../../utils/avatar-image'
import { replaceAvatar, uploadAvatar } from '../../utils/avatar'
import { readBodyWithLimit } from '../../utils/request-body'

// Room for the multipart boundaries and headers around the file.
const MULTIPART_OVERHEAD = 16 * 1024
const TOO_LARGE = `Image too large (max ${AVATAR_MAX_MB} MB)`

// Uploads a new avatar (multipart field `file`) to public storage.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)

  if (!isPublicStorageConfigured()) {
    throw createError({ statusCode: 501, statusMessage: 'Avatar uploads are not available' })
  }

  await readBodyWithLimit(event, AVATAR_MAX_BYTES + MULTIPART_OVERHEAD, TOO_LARGE)
  const parts = await readMultipartFormData(event)
  const file = parts?.find(part => part.name === 'file' && part.filename)
  if (!file) {
    throw createError({ statusCode: 400, statusMessage: 'No image provided' })
  }

  const uploaded = await uploadAvatar(file.data)
  if (!uploaded.ok) {
    throw uploaded.reason === 'too_large'
      ? createError({ statusCode: 413, statusMessage: TOO_LARGE })
      : createError({ statusCode: 415, statusMessage: `Use a ${avatarTypesText()} image` })
  }
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
