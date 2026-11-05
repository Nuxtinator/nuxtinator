<script setup lang="ts">
import type { KanbanProjectModel as Project } from './types'

const props = defineProps<{
  projects: Project[]
  // Cards sitting in the FEEDBACK INBOX column, keyed by project id.
  inboxCounts: Record<string, number>
  // null = "All projects" view.
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [projectId: string | null]
}>()

const totalInbox = computed(() =>
  Object.values(props.inboxCounts).reduce((a, b) => a + b, 0)
)

function countFor(id: string): number {
  return props.inboxCounts[id] ?? 0
}
</script>

<template>
  <nav class="flex flex-col gap-1">
    <button
      type="button"
      class="flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors text-left"
      :class="selectedId === null
        ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
        : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
      @click="emit('select', null)"
    >
      <UIcon
        name="i-lucide-layout-grid"
        class="size-5 shrink-0"
      />
      <span class="flex-1 truncate">All projects</span>
      <UBadge
        v-if="totalInbox > 0"
        color="primary"
        variant="solid"
        size="sm"
      >
        {{ totalInbox > 99 ? '99+' : totalInbox }}
      </UBadge>
    </button>

    <button
      v-for="p in projects"
      :key="p.id"
      type="button"
      class="flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors text-left"
      :class="selectedId === p.id
        ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
        : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
      @click="emit('select', p.id)"
    >
      <UIcon
        name="i-lucide-folder"
        class="size-5 shrink-0"
      />
      <span class="flex-1 truncate">{{ p.name }}</span>
      <UIcon
        v-if="p.visibility === 'teams'"
        name="i-lucide-users"
        class="size-4 shrink-0 text-(--ui-text-dimmed)"
        :aria-label="`Only ${p.teams.map(t => t.name).join(', ')}`"
        :title="`Only ${p.teams.map(t => t.name).join(', ')}`"
      />
      <UBadge
        v-if="countFor(p.id) > 0"
        color="primary"
        variant="solid"
        size="sm"
      >
        {{ countFor(p.id) > 99 ? '99+' : countFor(p.id) }}
      </UBadge>
    </button>
  </nav>
</template>
