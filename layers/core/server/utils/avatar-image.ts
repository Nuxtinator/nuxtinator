// What counts as an avatar image. Free of server dependencies so it can be unit-tested.
import { isIP } from 'node:net'

export const AVATAR_FOLDER = 'avatars'
export const AVATAR_MAX_MB = 2
export const AVATAR_MAX_BYTES = AVATAR_MAX_MB * 1024 * 1024

// Accepted avatar types, with the file extension each is stored under and its name.
export const AVATAR_TYPES = {
  'image/jpeg': { ext: 'jpg', name: 'JPEG' },
  'image/png': { ext: 'png', name: 'PNG' },
  'image/gif': { ext: 'gif', name: 'GIF' },
  'image/webp': { ext: 'webp', name: 'WebP' }
} as const

export type AvatarType = keyof typeof AVATAR_TYPES

// The accepted types as a phrase, e.g. "JPEG, PNG, GIF or WebP".
export function avatarTypesText(): string {
  const names = Object.values(AVATAR_TYPES).map(t => t.name)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join('')
}

// The image type of the bytes themselves, or null when they aren't one of the
// accepted types. Whatever a client or provider claims is ignored.
export function avatarImageType(data: Uint8Array): AvatarType | null {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => data[offset + i] === b)
  if (at(0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg'
  if (at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png'
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return null
}

// Whether the avatar download may request this URL: HTTPS only, and never an
// IP address, so a redirect can't point it at an internal or metadata service.
export function isAllowedAvatarUrl(url: URL): boolean {
  return url.protocol === 'https:' && !isIP(url.hostname.replace(/^\[|\]$/g, ''))
}
