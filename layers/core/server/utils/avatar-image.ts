// What counts as an avatar image. Free of server dependencies so it can be unit-tested.

export const AVATAR_FOLDER = 'avatars'
export const AVATAR_MAX_MB = 2
export const AVATAR_MAX_BYTES = AVATAR_MAX_MB * 1024 * 1024

// Accepted avatar types and the file extension each is stored under.
export const AVATAR_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

// The image type of the bytes themselves, or null when they aren't one of the
// accepted types. Whatever a client or provider claims is ignored.
export function avatarImageType(data: Uint8Array): string | null {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => data[offset + i] === b)
  if (at(0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg'
  if (at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png'
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return null
}
