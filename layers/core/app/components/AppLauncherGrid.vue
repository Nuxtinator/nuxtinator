<script setup lang="ts">
defineProps<{
  apps: Array<{ id: string, path: string, icon?: string, title: string, description?: string }>
  emptyText: string
}>()
</script>

<template>
  <div
    v-if="apps.length === 0"
    class="text-sm text-(--ui-text-muted)"
  >
    {{ emptyText }}
  </div>
  <div
    v-else
    class="grid grid-cols-2 sm:grid-cols-3 gap-3"
  >
    <NuxtLink
      v-for="app in apps"
      :key="app.id"
      :to="app.path"
      class="flex flex-col items-start rounded-md border border-(--ui-border) dark:border-(--ui-border-accented) p-4 bg-(--ui-bg-elevated)/50 hover:bg-(--ui-bg-elevated) transition-colors"
    >
      <AppIcon
        :name="app.icon"
        class="size-6 mb-2 text-sm"
      />
      <div class="font-medium">
        {{ app.title }}
      </div>
      <div
        v-if="app.description"
        class="text-xs text-(--ui-text-muted) mt-1 line-clamp-2"
      >
        {{ app.description }}
      </div>
    </NuxtLink>
  </div>
</template>
