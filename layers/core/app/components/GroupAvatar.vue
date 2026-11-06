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

const avatar = computed(() => groupAvatarProps(props))
</script>

<template>
  <UAvatar
    v-bind="avatar"
    :size="size"
    class="shrink-0"
  />
</template>
