import type { H3Event } from 'h3'
import { deleteFromS3, isPublicStorageConfigured } from '../../utils/storage'
import { AVATAR_MAX_BYTES, AVATAR_MAX_MB, avatarTypesText } from '../../utils/avatar-image'
import { replaceAvatar, uploadAvatar } from '../../utils/avatar'

// Room for the multipart boundaries and headers around the file.
const MULTIPART_OVERHEAD = 16 * 1024

function tooLarge() {
  return createError({ statusCode: 413, statusMessage: `Image too large (max ${AVATAR_MAX_MB} MB)` })
}

// Reads the request body, stopping with 413 once it passes `limit` bytes,
// whether or not the client declared a Content-Length.
function readCappedBody(event: H3Event, limit: number): Promise<Buffer> {
  if (Number(getHeader(event, 'content-length')) > limit) return Promise.reject(tooLarge())
  const req = event.node.req
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        req.removeAllListeners('data')
        req.pause()
        // Close the connection after the 413 instead of draining the rest of the body.
        event.node.res.once('finish', () => req.destroy())
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Uploads a new avatar (multipart field `file`) to public storage.
export default defineEventHandler(async (event) => {
  const user = requireAuth(event)

  if (!isPublicStorageConfigured()) {
    throw createError({ statusCode: 501, statusMessage: 'Avatar uploads are not available' })
  }

  const body = await readCappedBody(event, AVATAR_MAX_BYTES + MULTIPART_OVERHEAD)
  const form = await new Response(new Uint8Array(body), { headers: { 'content-type': getHeader(event, 'content-type') || '' } })
    .formData()
    .catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof Blob)) {
    throw createError({ statusCode: 400, statusMessage: 'No image provided' })
  }
  if (file.size > AVATAR_MAX_BYTES) throw tooLarge()

  const uploaded = await uploadAvatar(new Uint8Array(await file.arrayBuffer()))
  if (!uploaded) {
    throw createError({ statusCode: 415, statusMessage: `Use a ${avatarTypesText()} image` })
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
