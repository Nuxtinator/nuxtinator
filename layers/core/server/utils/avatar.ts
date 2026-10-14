import { sql } from 'kysely'
import { db } from './database'
import { deleteFromS3, getPublicUrl, isPublicStorageConfigured, uploadToS3 } from './storage'
import { AVATAR_FOLDER, AVATAR_MAX_BYTES, AVATAR_TYPES, avatarImageType, isAllowedAvatarUrl } from './avatar-image'

export type AvatarUpload =
  | { ok: true, url: string, key: string }
  | { ok: false, reason: 'too_large' | 'unsupported' }

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

const DOWNLOAD_TIMEOUT_MS = 5000
const DOWNLOAD_MAX_REDIRECTS = 3

// Downloads an image to use as an avatar, or null when the request fails,
// times out, passes the size limit or is redirected somewhere not allowed.
// Redirects are followed by hand so every hop is checked.
export async function downloadAvatar(input: string): Promise<Buffer | null> {
  try {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    let url = new URL(input)
    for (let hop = 0; ; hop++) {
      if (!isAllowedAvatarUrl(url)) return null
      const res = await fetch(url, { redirect: 'manual', signal })
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel()
        const location = res.headers.get('location')
        if (!location || hop >= DOWNLOAD_MAX_REDIRECTS) return null
        url = new URL(location, url)
        continue
      }
      if (!res.ok || !res.body) return null
      if (Number(res.headers.get('content-length')) > AVATAR_MAX_BYTES) {
        await res.body.cancel()
        return null
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
          return null
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks)
    }
  } catch {
    return null
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
