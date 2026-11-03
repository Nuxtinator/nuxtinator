<script setup lang="ts">
// Popover for tagging one conversation: toggle palette tags on/off, create a
// new tag inline (name + colour swatch, which also assigns it), and manage the
// palette with a two-step delete confirm. The parent owns persistence — this
// component only emits intent; the selected set it renders comes back down as a
// prop after the server sanitizes and stores it.
import { INBOX_TAG_COLORS, type InboxTag, type InboxTagColor } from '../../composables/useInboxTags'

const props = defineProps<{
  palette: InboxTag[]
  selected: string[]
}>()

const emit = defineEmits<{
  setTags: [slugs: string[]]
  createTag: [name: string, color: InboxTagColor]
  deleteTag: [slug: string]
}>()

const open = ref(false)
const newName = ref('')
const newColor = ref<InboxTagColor>('primary')
const confirmDelete = ref<string | null>(null)

const selectedSet = computed(() => new Set(props.selected))
const selectedTags = computed(() => props.selected.map(s => props.palette.find(t => t.slug === s) ?? { slug: s, name: s, color: 'neutral' as const }))

function toggle(slug: string) {
  const next = selectedSet.value.has(slug)
    ? props.selected.filter(s => s !== slug)
    : [...props.selected, slug]
  emit('setTags', next)
}

function submitCreate() {
  const name = newName.value.trim()
  if (!name) return
  emit('createTag', name, newColor.value)
  newName.value = ''
  newColor.value = 'primary'
}

function requestDelete(slug: string) {
  if (confirmDelete.value === slug) {
    emit('deleteTag', slug)
    confirmDelete.value = null
  } else {
    confirmDelete.value = slug
  }
}

// Reset the transient create/confirm state whenever the popover closes.
watch(open, (v) => {
  if (!v) {
    confirmDelete.value = null
    newName.value = ''
  }
})
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <UButton
      :icon="selectedTags.length ? 'i-lucide-pencil' : 'i-lucide-tag'"
      :label="selectedTags.length ? undefined : 'Add tag'"
      :aria-label="selectedTags.length ? 'Edit tags' : undefined"
      size="xs"
      color="neutral"
      variant="ghost"
    />

    <template #content>
      <div class="w-64 p-2 space-y-2">
        <div v-if="palette.length" class="space-y-0.5 max-h-56 overflow-y-auto">
          <div
            v-for="t in palette"
            :key="t.slug"
            class="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-(--ui-bg-accented)/50"
          >
            <button
              type="button"
              class="flex items-center gap-2 flex-1 min-w-0 text-left text-sm"
              @click="toggle(t.slug)"
            >
              <UIcon
                :name="selectedSet.has(t.slug) ? 'i-lucide-check-square' : 'i-lucide-square'"
                class="size-4 shrink-0"
                :class="selectedSet.has(t.slug) ? 'text-(--ui-text-highlighted)' : 'text-(--ui-text-dimmed)'"
              />
              <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: inboxTagDotColor(t.color) }" />
              <span class="truncate">{{ t.name }}</span>
            </button>
            <UButton
              :icon="confirmDelete === t.slug ? 'i-lucide-trash-2' : 'i-lucide-x'"
              :color="confirmDelete === t.slug ? 'error' : 'neutral'"
              variant="ghost"
              size="xs"
              :aria-label="confirmDelete === t.slug ? 'Confirm delete tag' : 'Delete tag'"
              @click="requestDelete(t.slug)"
            />
          </div>
        </div>
        <p v-else class="px-2 py-1 text-xs text-(--ui-text-dimmed)">No tags yet — create one below.</p>

        <div class="border-t border-(--ui-border) pt-2 space-y-2">
          <UInput
            v-model="newName"
            placeholder="New tag name…"
            size="xs"
            class="w-full"
            @keydown.enter.prevent="submitCreate"
          />
          <div class="flex items-center justify-between gap-1">
            <div class="flex items-center gap-1">
              <button
                v-for="c in INBOX_TAG_COLORS"
                :key="c"
                type="button"
                class="size-4 rounded-full ring-offset-1 ring-offset-(--ui-bg) transition-shadow"
                :class="newColor === c ? 'ring-2 ring-(--ui-border-inverted)' : ''"
                :style="{ backgroundColor: inboxTagDotColor(c) }"
                :aria-label="`Colour ${c}`"
                @click="newColor = c"
              />
            </div>
            <UButton label="Add" icon="i-lucide-plus" size="xs" :disabled="!newName.trim()" @click="submitCreate" />
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
