<script setup lang="ts">
// Inline link-list editor: one row per { url, label } value with a remove
// button, plus an add row. Every change commits the full list (the server
// replaces it). Bare domains are accepted — the server normalizes to https.
import type { RecordsLinkValue } from '#records'
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: RecordsLinkValue[]]
}>()

const current = computed<RecordsLinkValue[]>(() => {
  const raw = Array.isArray(props.modelValue) ? props.modelValue : []
  return raw.filter((v): v is RecordsLinkValue => v !== null && typeof v === 'object' && 'url' in v)
})

const draftUrl = ref('')
const draftLabel = ref('')

function add() {
  const url = draftUrl.value.trim()
  if (url === '') return
  const label = draftLabel.value.trim()
  emit('commit', [...current.value, label === '' ? { url } : { url, label }])
  draftUrl.value = ''
  draftLabel.value = ''
}

function remove(index: number) {
  emit('commit', current.value.filter((_, i) => i !== index))
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="(link, i) in current"
      :key="`${link.url}-${i}`"
      class="flex items-center gap-2"
    >
      <a
        :href="link.url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-(--ui-primary) hover:underline truncate"
      >{{ link.label || link.url }}</a>
      <UButton
        icon="i-lucide-x"
        variant="ghost"
        color="neutral"
        size="xs"
        :aria-label="`Remove ${link.label || link.url}`"
        @click="remove(i)"
      />
    </div>
    <div class="flex flex-wrap gap-2">
      <UInput
        v-model="draftUrl"
        placeholder="example.com/page"
        class="flex-1 min-w-40 sm:max-w-xs"
        @keydown.enter.prevent="add"
      />
      <UInput
        v-model="draftLabel"
        placeholder="Label (optional)"
        class="flex-1 min-w-28 max-w-36"
        @keydown.enter.prevent="add"
      />
      <UButton
        icon="i-lucide-plus"
        variant="soft"
        :disabled="draftUrl.trim() === ''"
        aria-label="Add link"
        @click="add"
      />
    </div>
  </div>
</template>
