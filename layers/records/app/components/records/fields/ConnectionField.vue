<script setup lang="ts">
// Inline connection editor: async name typeahead over the target type's
// records, committing the full id list (the server replaces the edge set).
// Linked records render as chips that navigate to their detail pages.
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

const current = computed<RecordsConnectedRecord[]>(() => {
  const raw = Array.isArray(props.modelValue) ? props.modelValue : []
  return raw.map((v) => {
    if (v !== null && typeof v === 'object' && 'id' in v) return v as RecordsConnectedRecord
    const id = String(v)
    return { id, name: knownNames.value.get(id) ?? id }
  })
})

watch(current, (list) => {
  for (const item of list) {
    if (item.name !== item.id) knownNames.value.set(item.id, item.name)
  }
}, { immediate: true })

const searchTerm = ref('')
const results = ref<RecordsConnectedRecord[]>([])
const loading = ref(false)

async function search(q: string): Promise<void> {
  const target = props.field.target
  if (!target) return
  loading.value = true
  try {
    const res = await $fetch<{ items: RecordsConnectedRecord[] }>(`/api/records/entries/${target}/search`, {
      query: { q: q.trim() || undefined, limit: 10 }
    })
    results.value = res.items
    for (const item of res.items) knownNames.value.set(item.id, item.name)
  } catch {
    // Keep the previous results on a failed search.
  } finally {
    loading.value = false
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
    if (!out.some(i => i.value === item.id)) out.push({ label: item.name, value: item.id })
  }
  return out
})

const selectedIds = computed(() => current.value.map(c => c.id))

function onChange(value: string[]) {
  emit('commit', value)
}
</script>

<template>
  <div class="space-y-2">
    <USelectMenu
      v-model:search-term="searchTerm"
      :model-value="selectedIds"
      :items="items"
      multiple
      ignore-filter
      :loading="loading"
      value-key="value"
      label-key="label"
      placeholder="Link records..."
      class="w-full sm:max-w-xs"
      @update:model-value="onChange"
    />
    <div
      v-if="current.length > 0"
      class="flex flex-wrap gap-1.5"
    >
      <UButton
        v-for="item in current"
        :key="item.id"
        :to="typePath(field.target ?? '', item.id)"
        color="neutral"
        variant="subtle"
        size="xs"
        icon="i-lucide-link"
      >
        {{ item.name }}
      </UButton>
    </div>
  </div>
</template>
