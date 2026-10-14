import { sql } from 'kysely'
import { db } from './database'
import { deleteFromS3, getPublicUrl, isPublicStorageConfigured } from './storage'

export const AVATAR_FOLDER = 'avatars'
export const AVATAR_MAX_MB = 2
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// The storage key of an avatar this app uploaded, or null for any other URL
// (such as a provider's photo stored as-is).
function storedAvatarKey(url: string): string | null {
  if (!url || !isPublicStorageConfigured()) return null
  const base = getPublicUrl('')
  if (!url.startsWith(base)) return null
  const key = url.slice(base.length)
  return key.startsWith(`${AVATAR_FOLDER}/`) && !key.includes('..') ? key : null
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
  const key = previous !== avatar ? storedAvatarKey(previous) : null
  if (!key) return
  try {
    await deleteFromS3(key, 'public')
  } catch (err) {
    console.warn('[avatar] could not delete the previous avatar:', (err as Error).message)
  }
}
