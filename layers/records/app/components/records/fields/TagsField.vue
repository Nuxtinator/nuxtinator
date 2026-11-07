<script setup lang="ts">
// Inline tags editor: free-text chips committing the full list on every
// add/remove (the server replaces the list).
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string[]]
}>()

const current = computed<string[]>(() =>
  Array.isArray(props.modelValue) ? props.modelValue.map(String) : []
)

function onChange(value: string[]) {
  const next = value.map(t => t.trim()).filter(t => t !== '')
  if (JSON.stringify(next) === JSON.stringify(current.value)) return
  emit('commit', next)
}
</script>

<template>
  <UInputTags
    :model-value="current"
    placeholder="Add tag..."
    class="w-full sm:max-w-xs"
    @update:model-value="onChange"
  />
</template>
