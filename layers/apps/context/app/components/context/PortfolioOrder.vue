<script setup lang="ts">
// The org's portfolios in display order, reordered by drag or the arrows.
// Each change saves the full order at once.
interface PortfolioListItem {
  id: string
  slug: string
  name: string
  color: string | null
  icon_url: string | null
}

const { data, refresh } = await useAsyncData(
  'context-portfolio-order',
  () => $fetch<{ portfolios: PortfolioListItem[] }, string>('/api/context/portfolios')
)

// Local copy the reorder controls mutate, so a drag or a move shows
// immediately and rolls back if the save fails.
const ordered = ref<PortfolioListItem[]>([])
watch(() => data.value?.portfolios ?? [], next => (ordered.value = [...next]), { immediate: true })

const dragId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

async function persistOrder(next: PortfolioListItem[]) {
  const previous = ordered.value
  ordered.value = next
  saving.value = true
  error.value = null
  try {
    await $fetch('/api/context/portfolio-order', {
      method: 'PUT',
      body: { ids: next.map(p => p.id) }
    })
    await refresh()
    await refreshNuxtData('context-sidebar-portfolios')
  } catch (e) {
    ordered.value = previous
    error.value = (e as { statusMessage?: string }).statusMessage ?? 'Reorder failed.'
  } finally {
    saving.value = false
  }
}

function reordered(from: number, to: number): PortfolioListItem[] {
  const next = [...ordered.value]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

function move(index: number, delta: number) {
  const to = index + delta
  if (to < 0 || to >= ordered.value.length) return
  persistOrder(reordered(index, to))
}

function onDragStart(id: string, event: DragEvent) {
  dragId.value = id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
}

function onDragEnd() {
  dragId.value = null
  dragOverId.value = null
}

function onDrop(overId: string) {
  const from = ordered.value.findIndex(p => p.id === dragId.value)
  const to = ordered.value.findIndex(p => p.id === overId)
  onDragEnd()
  if (from < 0 || to < 0 || from === to) return
  persistOrder(reordered(from, to))
}
</script>

<template>
  <div class="space-y-4">
    <ul v-if="ordered.length" class="divide-y divide-(--ui-border) border border-(--ui-border) rounded">
      <li
        v-for="(p, i) in ordered"
        :key="p.id"
        class="flex items-center gap-2 p-3 transition-colors"
        :class="{
          'opacity-40': dragId === p.id,
          'bg-(--ui-bg-elevated)': dragOverId === p.id && dragId !== null && dragId !== p.id
        }"
        :draggable="!saving"
        @dragstart="onDragStart(p.id, $event)"
        @dragend="onDragEnd"
        @dragover.prevent="dragOverId = p.id"
        @drop.prevent="onDrop(p.id)"
      >
        <UIcon name="i-lucide-grip-vertical" class="shrink-0 size-4 text-(--ui-text-dimmed) cursor-grab" />
        <span class="shrink-0 w-5 h-5 flex items-center justify-center">
          <img
            v-if="p.icon_url"
            :src="p.icon_url"
            :alt="''"
            class="w-5 h-5 rounded-full object-cover"
          >
          <UIcon
            v-else
            name="i-lucide-book-open-text"
            class="size-4"
            :style="p.color ? { color: p.color } : undefined"
          />
        </span>
        <span class="font-medium truncate flex-1">{{ p.name }}</span>
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-chevron-up"
          size="sm"
          :disabled="i === 0 || saving"
          :aria-label="`Move ${p.name} up`"
          @click="move(i, -1)"
        />
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-chevron-down"
          size="sm"
          :disabled="i === ordered.length - 1 || saving"
          :aria-label="`Move ${p.name} down`"
          @click="move(i, 1)"
        />
      </li>
    </ul>
    <p v-else class="text-sm text-(--ui-text-muted)">
      No portfolios yet.
    </p>

    <p v-if="error" class="text-sm text-(--ui-error)">
      {{ error }}
    </p>
  </div>
</template>
