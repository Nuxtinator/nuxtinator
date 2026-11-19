<script setup lang="ts">
// Inline tags editor committing the full list on every add/remove (the
// server replaces the list). With `suggestUrl` it's a combobox offering the
// tags already used on records the caller can see, most used first, so
// spellings stay the same; a typed tag nobody has used is added with
// "Create". Without it (a view's own tags field) it takes free-text chips.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
  /** GET endpoint answering `?q=` with `{ tags: string[] }`. */
  suggestUrl?: string
}>()

const emit = defineEmits<{
  commit: [value: string[]]
}>()

const current = computed<string[]>(() =>
  Array.isArray(props.modelValue) ? props.modelValue.map(String) : []
)

function onChange(value: string[]) {
  const next: string[] = []
  for (const tag of value.map(t => t.trim())) {
    if (tag !== '' && !next.includes(tag)) next.push(tag)
  }
  if (JSON.stringify(next) === JSON.stringify(current.value)) return
  emit('commit', next)
}

const searchTerm = ref('')
const suggestions = ref<string[]>([])

async function loadSuggestions(q: string) {
  if (!props.suggestUrl) return
  try {
    const res = await $fetch<{ tags: string[] }>(props.suggestUrl, { query: q ? { q } : {} })
    if (q === searchTerm.value.trim()) suggestions.value = res.tags
  } catch {
    // No suggestions on a failed fetch; typing still creates tags.
  }
}

onMounted(() => loadSuggestions(''))

let timer: ReturnType<typeof setTimeout> | null = null
watch(searchTerm, (q) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => loadSuggestions(q.trim()), 200)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

// The server narrows suggestions to the typed text; the record's own tags
// that match it are listed too, so they show as picked.
const items = computed<string[]>(() => {
  const typed = searchTerm.value.trim().toLowerCase()
  const out = [...suggestions.value]
  for (const tag of current.value) {
    if (!out.includes(tag) && tag.toLowerCase().includes(typed)) out.push(tag)
  }
  return out
})

// "Create" shows unless the typed text already names a tag (any case), so a
// near-miss like "mvp" picks the existing "MVP" instead of adding a second.
const createItem = computed(() => {
  const typed = searchTerm.value.trim().toLowerCase()
  if (typed === '' || items.value.some(t => t.toLowerCase() === typed)) return false
  return { position: 'bottom' as const, when: 'always' as const }
})
</script>

<template>
  <UInputMenu
    v-if="suggestUrl"
    v-model:search-term="searchTerm"
    :model-value="current"
    :items="items"
    multiple
    ignore-filter
    open-on-focus
    :create-item="createItem"
    placeholder="Add tag..."
    class="w-full sm:max-w-xs"
    @update:model-value="onChange"
    @create="(tag: string) => onChange([...current, tag])"
  />
  <UInputTags
    v-else
    :model-value="current"
    placeholder="Add tag..."
    class="w-full sm:max-w-xs"
    @update:model-value="onChange"
  />
</template>
