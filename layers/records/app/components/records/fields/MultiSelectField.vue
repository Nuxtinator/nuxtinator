<script setup lang="ts">
// Inline multi_select editor: option keys from the merged field settings,
// committing the full selection on every change (the server replaces the
// list). Soft-deleted or unknown keys already on the record stay listed so
// they can be deselected.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string[]]
}>()

interface OptionItem {
  label: string
  value: string
}

const current = computed<string[]>(() =>
  Array.isArray(props.modelValue) ? props.modelValue.map(String) : []
)

const items = computed<OptionItem[]>(() => {
  const options = props.field.options ?? {}
  const out = Object.entries(options)
    .filter(([key, opt]) => !opt.deleted || current.value.includes(key))
    .map(([key, opt]) => ({ label: opt.label, value: key }))
  for (const key of current.value) {
    if (!options[key]) out.push({ label: key, value: key })
  }
  return out
})

function onChange(value: string[]) {
  emit('commit', value)
}
</script>

<template>
  <USelectMenu
    :model-value="current"
    :items="items"
    multiple
    value-key="value"
    label-key="label"
    placeholder="Select..."
    class="w-full sm:max-w-xs"
    @update:model-value="onChange"
  />
</template>
