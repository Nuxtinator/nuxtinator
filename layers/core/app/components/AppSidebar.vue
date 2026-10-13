<script setup lang="ts">
import type { AppEntry } from '#core/app/composables/useApps'

const props = defineProps<{
  app: AppEntry
}>()

const route = useRoute()

const { items } = await useAppNav(() => props.app.id)

const isActive = (path: string) => {
  if (route.path === path) return true
  return path !== props.app.path && route.path.startsWith(path + '/')
}
</script>

<template>
  <div class="flex flex-col h-full bg-(--chrome-bg)">
    <div class="px-5 py-4 border-b border-(--ui-border) flex items-center gap-2">
      <AppIcon
        :name="app.icon"
        class="size-5 text-xs text-(--ui-text-muted)"
      />
      <h2 class="text-lg font-semibold">
        {{ app.title }}
      </h2>
    </div>
    <nav class="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
      <NuxtLink
        v-for="item in items"
        :key="item.path"
        :to="item.path"
        class="flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors"
        :class="isActive(item.path)
          ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
          : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
      >
        <UIcon
          :name="item.icon || 'i-lucide-circle'"
          class="size-4 shrink-0"
        />
        <span>{{ item.title }}</span>
      </NuxtLink>
      <p
        v-if="items.length === 0"
        class="px-3 py-2 text-xs text-(--ui-text-muted)"
      >
        No items.
      </p>
    </nav>
  </div>
</template>
