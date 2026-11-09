<script setup lang="ts">
// A ref: one target owned by another layer (a meeting), picked through the
// field's ref source. The chosen target shows as a chip linking to it;
// a target the caller can't see, or one that's gone, shows as such.
import type { RecordsRefValue } from '#records'
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
  readonly?: boolean
}>()

const emit = defineEmits<{
  commit: [value: string | null]
}>()

// Labels seen so far, so a just-committed id renders before the server's
// hydrated value replaces it.
const knownLabels = ref(new Map<string, string>())

const current = computed<RecordsRefValue | null>(() => {
  const raw = props.modelValue
  if (raw !== null && typeof raw === 'object' && 'id' in raw) return raw as RecordsRefValue
  if (typeof raw === 'string' && raw !== '') return { id: raw, label: knownLabels.value.get(raw) ?? '' }
  return null
})

watch(current, (value) => {
  if (value?.label) knownLabels.value.set(value.id, value.label)
}, { immediate: true })

const chipLabel = computed(() => {
  const value = current.value
  if (!value) return ''
  if (value.hidden) return 'Hidden'
  if (value.missing) return 'Deleted'
  return value.label || '…'
})

const searchTerm = ref('')
const results = ref<Array<{ id: string, label: string }>>([])
const loading = ref(false)

async function search(q: string): Promise<void> {
  const source = props.field.source
  if (!source || props.readonly) return
  loading.value = true
  try {
    const res = await $fetch<{ items: Array<{ id: string, label: string }> }>(`/api/records/refs/${source}`, {
      query: { q: q.trim() || undefined, limit: 20 }
    })
    results.value = res.items
    for (const item of res.items) knownLabels.value.set(item.id, item.label)
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

const items = computed(() => {
  const out = results.value.map(r => ({ label: r.label, value: r.id }))
  const value = current.value
  if (value && !out.some(i => i.value === value.id)) out.push({ label: chipLabel.value, value: value.id })
  return out
})

function onChange(value: unknown) {
  const next = typeof value === 'string' && value !== '' ? value : null
  if (next === (current.value?.id ?? null)) return
  emit('commit', next)
}
</script>

<template>
  <div class="flex items-center gap-2 flex-wrap">
    <USelectMenu
      v-if="!readonly"
      v-model:search-term="searchTerm"
      :model-value="current?.id"
      :items="items"
      ignore-filter
      :loading="loading"
      value-key="value"
      label-key="label"
      placeholder="Choose..."
      class="w-full sm:max-w-xs"
      @update:model-value="onChange"
    />
    <UButton
      v-if="current"
      :to="current.url"
      color="neutral"
      variant="subtle"
      size="xs"
      :icon="current.hidden ? 'i-lucide-lock' : current.missing ? 'i-lucide-circle-off' : (field.icon || 'i-lucide-link')"
    >
      {{ chipLabel }}
    </UButton>
    <UButton
      v-if="current && !readonly && !field.required"
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="`Clear ${field.label}`"
      @click="emit('commit', null)"
    />
    <span
      v-if="!current && readonly"
      class="text-sm"
    >—</span>
  </div>
</template>
