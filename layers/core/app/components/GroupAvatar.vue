<script setup lang="ts">
// A group's avatar: its image, else its icon (an icon name, or short text
// such as an emoji), else its initials.
import type { AvatarProps } from '@nuxt/ui'

const props = withDefaults(defineProps<{
  name: string
  icon?: string | null
  image?: string | null
  size?: AvatarProps['size']
}>(), {
  icon: null,
  image: null,
  size: 'xs'
})

const iconName = computed(() => props.icon?.startsWith('i-') ? props.icon : undefined)
const text = computed(() => props.icon && !props.icon.startsWith('i-') ? props.icon : undefined)
</script>

<template>
  <UAvatar
    :src="image || undefined"
    :icon="iconName"
    :text="text"
    :alt="name"
    :size="size"
    class="shrink-0"
  />
</template>
