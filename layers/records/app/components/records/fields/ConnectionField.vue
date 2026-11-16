<script setup lang="ts">
// Inline connection editor: async name typeahead over the target type's
// records, committing the full id list (the server replaces the edge set).
// Linked records render as chips that navigate to their detail pages, each
// with an × that unlinks it, followed by a "+" that opens the picker.
import type { RecordsConnectedRecord } from '#records'
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string[]]
}>()

const typePath = useRecordsTypePath()

// Names seen so far (hydrated values + search results). Covers the
// optimistic window where the patched value is a bare id array until the
// server response replaces it with { id, name } objects.
const knownNames = ref(new Map<string, string>())
// Linked records the caller can't open: they keep their place, not a name.
const hiddenIds = ref(new Set<string>())

const current = computed<RecordsConnectedRecord[]>(() => {
  const raw = Array.isArray(props.modelValue) ? props.modelValue : []
  return raw.map((v) => {
    if (v !== null && typeof v === 'object' && 'id' in v) return v as RecordsConnectedRecord
    const id = String(v)
    if (hiddenIds.value.has(id)) return { id, name: '', hidden: true }
    return { id, name: knownNames.value.get(id) ?? id }
  })
})

watch(current, (list) => {
  for (const item of list) {
    if (item.hidden) hiddenIds.value.add(item.id)
    else if (item.name !== item.id) knownNames.value.set(item.id, item.name)
  }
}, { immediate: true })

const labelOf = (item: RecordsConnectedRecord) => item.hidden ? 'Hidden record' : item.name

const searchTerm = ref('')
const results = ref<RecordsConnectedRecord[]>([])

async function search(q: string): Promise<void> {
  const target = props.field.target
  if (!target) return
  try {
    const res = await $fetch<{ items: RecordsConnectedRecord[] }>(`/api/records/entries/${target}/search`, {
      query: { q: q.trim() || undefined, limit: 10 }
    })
    results.value = res.items
    for (const item of res.items) knownNames.value.set(item.id, item.name)
  } catch {
    // Keep the previous results on a failed search.
  }
}

onMounted(() => {
  search('')
})

let timer: ReturnType<typeof setTimeout> | null = null
watch(searchTerm, (q) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    search(q)
  }, 250)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

interface RecordItem {
  label: string
  value: string
}

// Search results plus any current links the search filtered out, so
// selected values always render with a label.
const items = computed<RecordItem[]>(() => {
  const out = results.value.map(r => ({ label: r.name, value: r.id }))
  for (const item of current.value) {
    if (!out.some(i => i.value === item.id)) out.push({ label: labelOf(item), value: item.id })
  }
  return out
})

const selectedIds = computed(() => current.value.map(c => c.id))

// A record has one parent: picking another replaces it.
function onChange(value: string[]) {
  emit('commit', props.field.hierarchy === 'parent' ? value.slice(-1) : value)
}

function remove(id: string) {
  emit('commit', selectedIds.value.filter(v => v !== id))
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5 min-h-8">
    <span
      v-for="item in current"
      :key="item.id"
      class="inline-flex items-center min-w-0 rounded-md bg-(--ui-bg-elevated) ring ring-inset ring-(--ui-border-accented)"
    >
      <UButton
        :to="item.hidden ? undefined : typePath(field.target ?? '', item.id)"
        color="neutral"
        variant="link"
        size="xs"
        :icon="item.hidden ? 'i-lucide-lock' : 'i-lucide-link'"
        class="min-w-0 pe-1"
      >
        <span class="truncate">{{ labelOf(item) }}</span>
      </UButton>
      <button
        type="button"
        :aria-label="`Unlink ${labelOf(item)}`"
        class="me-1.5 rounded-sm text-(--ui-text-dimmed) hover:text-(--ui-text)"
        @click="remove(item.id)"
      >
        <UIcon
          name="i-lucide-x"
          class="size-3.5 block"
        />
      </button>
    </span>
    <USelectMenu
      v-model:search-term="searchTerm"
      :model-value="selectedIds"
      :items="items"
      multiple
      ignore-filter
      value-key="value"
      label-key="label"
      variant="ghost"
      size="sm"
      trailing-icon=""
      :content="{ align: 'start' }"
      :aria-label="`Link to ${field.label}`"
      :class="{ '-ms-2.5': current.length === 0 }"
      :ui="{ base: current.length === 0 ? undefined : 'p-1.5', content: 'w-64' }"
      @update:model-value="onChange"
    >
      <UIcon
        name="i-lucide-plus"
        class="size-4 text-(--ui-text-dimmed)"
      />
      <span
        v-if="current.length === 0"
        class="text-(--ui-text-dimmed)"
      >Link record</span>
    </USelectMenu>
  </div>
</template>
