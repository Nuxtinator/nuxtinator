import type { AvatarProps } from '@nuxt/ui'

// UAvatar props for a group: its image, else its icon (an icon name, or short
// text such as an emoji), else its initials. Also usable as a menu or select
// item's `avatar`.
export function groupAvatarProps(group: { name: string, icon?: string | null, image?: string | null }): AvatarProps {
  const isIconName = !!group.icon?.startsWith('i-')
  return {
    src: group.image || undefined,
    icon: isIconName ? group.icon! : undefined,
    text: group.icon && !isIconName ? group.icon : undefined,
    alt: group.name
  }
}
