<script setup lang="ts">
// Sidebar link to the suggestion review queue, with the number of open
// suggestion sets the viewer can see.
defineProps<{ count: number }>()

const route = useRoute()
const path = computed(() => {
  const org = route.params.orgSlug as string | undefined
  return org ? `/@${org}/context/suggestions` : '/context/suggestions'
})
const active = computed(() => route.path.startsWith(path.value))
</script>

<template>
  <NuxtLink
    :to="path"
    class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition"
    :class="active
      ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
      : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
  >
    <UIcon name="i-lucide-git-pull-request-arrow" class="size-4 shrink-0" />
    <span class="flex-1">Suggestions</span>
    <UBadge v-if="count > 0" color="warning" variant="subtle" size="sm">
      {{ count }}
    </UBadge>
  </NuxtLink>
</template>
