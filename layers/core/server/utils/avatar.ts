import type { H3Event } from 'h3'
import { sql } from 'kysely'
import { db } from './database'
import { deleteFromS3, getPublicUrl, isPublicStorageConfigured, uploadToS3 } from './storage'
import { AVATAR_FOLDER, AVATAR_MAX_BYTES, AVATAR_MAX_MB, AVATAR_TYPES, avatarImageType, avatarTypesText, isAllowedAvatarUrl, isAvatarHostListed } from './avatar-image'
import { readBodyWithLimit } from './request-body'

export type AvatarUpload = { ok: true, url: string, key: string } | { ok: false, reason: 'too_large' | 'unsupported' }

// Uploads avatar bytes to public storage, unless they are too large or not an
// accepted image.
export async function uploadAvatar(data: Uint8Array): Promise<AvatarUpload> {
  if (data.byteLength > AVATAR_MAX_BYTES) return { ok: false, reason: 'too_large' }
  const type = avatarImageType(data)
  if (!type) return { ok: false, reason: 'unsupported' }
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const uploaded = await uploadToS3(buffer, `avatar.${AVATAR_TYPES[type].ext}`, type, 'public', AVATAR_FOLDER)
  return { ok: true, url: uploaded.url, key: uploaded.key }
}

// Room for the multipart boundaries and headers around the file.
const MULTIPART_OVERHEAD = 16 * 1024
const TOO_LARGE = `Image too large (max ${AVATAR_MAX_MB} MB)`

// Uploads the image in a multipart request's `file` field to public storage.
// Throws 501 without public storage, 400 without a file, 413/415 for a file
// that is too large or not an accepted image.
export async function uploadAvatarFromRequest(event: H3Event): Promise<{ url: string, key: string }> {
  if (!isPublicStorageConfigured()) {
    throw createError({ statusCode: 501, statusMessage: 'Avatar uploads are not available' })
  }

  const body = await readBodyWithLimit(event, AVATAR_MAX_BYTES + MULTIPART_OVERHEAD, TOO_LARGE)
  // The web parser handles quoted boundaries and large parts, unlike h3's readMultipartFormData.
  const form = await new Response(body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': getHeader(event, 'content-type') || '' } })
    .formData()
    .catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof Blob)) {
    throw createError({ statusCode: 400, statusMessage: 'No image provided' })
  }

  const uploaded = await uploadAvatar(Buffer.from(await file.arrayBuffer()))
  if (!uploaded.ok) {
    throw uploaded.reason === 'too_large'
      ? createError({ statusCode: 413, statusMessage: TOO_LARGE })
      : createError({ statusCode: 415, statusMessage: `Use a ${avatarTypesText()} image` })
  }
  return { url: uploaded.url, key: uploaded.key }
}

// Sets an uploaded avatar as the user's, deleting the upload if that fails.
export async function setUploadedAvatar(userId: string, uploaded: { url: string, key: string }): Promise<void> {
  try {
    await replaceAvatar(userId, uploaded.url)
  } catch (err) {
    await deleteFromS3(uploaded.key, 'public').catch(() => {})
    throw err
  }
}

const DOWNLOAD_TIMEOUT_MS = 5000
const DOWNLOAD_MAX_REDIRECTS = 3

// Downloads an image to use as an avatar from one of `hosts`, or null when the
// request fails, times out, passes the size limit or leaves those hosts.
export async function downloadAvatar(input: string, hosts: string[]): Promise<Buffer | null> {
  const skip = (reason: string) => {
    console.warn(`[avatar] download skipped: ${reason}`)
    return null
  }
  try {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    let url = new URL(input)
    for (let hop = 0; ; hop++) {
      if (!isAllowedAvatarUrl(url) || !isAvatarHostListed(url.hostname, hosts)) return skip(`host not allowed (${url.host})`)
      const res = await fetch(url, { redirect: 'manual', signal })
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel()
        const location = res.headers.get('location')
        if (!location || hop >= DOWNLOAD_MAX_REDIRECTS) return skip('too many or empty redirects')
        url = new URL(location, url)
        continue
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel()
        return skip(`HTTP ${res.status}`)
      }
      if (Number(res.headers.get('content-length')) > AVATAR_MAX_BYTES) {
        await res.body.cancel()
        return skip('too large')
      }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > AVATAR_MAX_BYTES) {
          await reader.cancel()
          return skip('too large')
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks)
    }
  } catch (err) {
    return skip((err as Error).message)
  }
}

// The storage key of an avatar this app uploaded, or null for any other URL
// (such as a provider's photo stored as-is).
function storedAvatarKey(url: string): string | null {
  if (!url || !isPublicStorageConfigured()) return null
  const base = getPublicUrl('')
  if (!url.startsWith(base)) return null
  const key = url.slice(base.length)
  return key.startsWith(`${AVATAR_FOLDER}/`) && !key.includes('..') ? key : null
}

// Deletes an avatar file from storage when this app uploaded it. Never throws.
export async function deleteStoredAvatar(url: string): Promise<void> {
  const key = storedAvatarKey(url)
  if (!key) return
  try {
    await deleteFromS3(key, 'public')
  } catch (err) {
    console.warn('[avatar] could not delete a stored avatar:', (err as Error).message)
  }
}

// Sets the user's avatar ('' for none) and deletes the previous one from
// storage when this app uploaded it.
export async function replaceAvatar(userId: string, avatar: string): Promise<void> {
  const previous = await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('users').select('avatar').where('id', '=', userId).forUpdate().executeTakeFirst()
    if (!row) throw createError({ statusCode: 404, statusMessage: 'User not found' })
    await trx.updateTable('users').set({ avatar, updated: sql`now()` }).where('id', '=', userId).execute()
    return row.avatar
  })
  if (previous !== avatar) await deleteStoredAvatar(previous)
}
