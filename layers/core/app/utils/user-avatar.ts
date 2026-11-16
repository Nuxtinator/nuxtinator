import type { AvatarProps } from '@nuxt/ui'
import { userInitials } from './user-initials'

// The colors an avatar without an image can take: a background and the
// initials' color for each hue, in light and dark mode. Class names are
// written out in full so Tailwind generates them.
export const USER_AVATAR_COLORS = [
  { bg: 'bg-red-100 dark:bg-red-900', text: 'text-red-800 dark:text-red-200' },
  { bg: 'bg-orange-100 dark:bg-orange-900', text: 'text-orange-800 dark:text-orange-200' },
  { bg: 'bg-amber-100 dark:bg-amber-900', text: 'text-amber-800 dark:text-amber-200' },
  { bg: 'bg-lime-100 dark:bg-lime-900', text: 'text-lime-800 dark:text-lime-200' },
  { bg: 'bg-emerald-100 dark:bg-emerald-900', text: 'text-emerald-800 dark:text-emerald-200' },
  { bg: 'bg-teal-100 dark:bg-teal-900', text: 'text-teal-800 dark:text-teal-200' },
  { bg: 'bg-cyan-100 dark:bg-cyan-900', text: 'text-cyan-800 dark:text-cyan-200' },
  { bg: 'bg-blue-100 dark:bg-blue-900', text: 'text-blue-800 dark:text-blue-200' },
  { bg: 'bg-indigo-100 dark:bg-indigo-900', text: 'text-indigo-800 dark:text-indigo-200' },
  { bg: 'bg-violet-100 dark:bg-violet-900', text: 'text-violet-800 dark:text-violet-200' },
  { bg: 'bg-fuchsia-100 dark:bg-fuchsia-900', text: 'text-fuchsia-800 dark:text-fuchsia-200' },
  { bg: 'bg-pink-100 dark:bg-pink-900', text: 'text-pink-800 dark:text-pink-200' }
] as const

export type UserAvatarColor = typeof USER_AVATAR_COLORS[number]

/**
 * A person's avatar color, picked from their id so it is the same on every
 * page and device without being stored. No id gives no color.
 */
export function userAvatarColor(id: string | null | undefined): UserAvatarColor | null {
  if (!id) return null
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return USER_AVATAR_COLORS[hash % USER_AVATAR_COLORS.length]!
}

// UAvatar props for a person: their image, else their two initials on their
// color. Also usable as a menu or select item's `avatar`.
export function userAvatarProps(user: {
  id?: string | null
  name?: string | null
  email?: string | null
  image?: string | null
}): AvatarProps {
  const color = userAvatarColor(user.id)
  return {
    src: user.image || undefined,
    alt: user.name || user.email || undefined,
    text: userInitials(user.name, user.email),
    class: color?.bg,
    ui: color ? { fallback: color.text } : undefined
  }
}
