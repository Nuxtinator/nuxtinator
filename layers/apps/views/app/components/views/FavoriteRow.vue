<script setup lang="ts">
// One favorite on the landing page. A card opens on its view with the card
// open, or as the record's page once that view is out of reach; a board
// opens the board. The star takes it off the favorites.
import type { ViewsFavorite } from '../../utils/views-types'

const props = defineProps<{
  favorite: ViewsFavorite
}>()

const viewsPath = useViewsPath()
const typePath = useRecordsTypePath()
const { types } = useRecordsTypes()
const { toggle } = useViewsFavorites()

const to = computed(() => {
  const f = props.favorite
  if (f.kind === 'board') return viewsPath(`/${viewsSubtasksViewId(f.recordId)}`)
  if (f.viewId) return { path: viewsPath(`/${f.viewId}`), query: { card: f.recordId } }
  return typePath(f.recordType, f.recordId)
})

const icon = computed(() => props.favorite.kind === 'board'
  ? 'i-lucide-kanban'
  : types.value.find(t => t.key === props.favorite.recordType)?.icon || 'i-lucide-file-text')

const detail = computed(() => {
  const f = props.favorite
  if (f.kind === 'board') return 'Board'
  return f.viewName ? `Card · ${f.viewName}` : 'Card'
})
</script>

<template>
  <div class="flex items-center pr-2 hover:bg-(--ui-bg-elevated) transition-colors">
    <NuxtLink
      :to="to"
      class="flex flex-1 min-w-0 items-center gap-3 px-4 py-3"
    >
      <UIcon
        :name="icon"
        class="size-5 shrink-0 text-(--ui-text-muted)"
      />
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium truncate">
          {{ favorite.name }}
        </p>
        <p class="text-xs text-(--ui-text-muted) truncate">
          {{ detail }}
        </p>
      </div>
    </NuxtLink>
    <UTooltip text="Remove from favorites">
      <UButton
        icon="i-lucide-star"
        variant="ghost"
        color="warning"
        size="xs"
        aria-label="Remove from favorites"
        @click="toggle(favorite.kind, favorite.recordId)"
      />
    </UTooltip>
  </div>
</template>
