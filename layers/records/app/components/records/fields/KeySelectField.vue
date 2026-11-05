<script setup lang="ts">
// Inline key_select editor: option keys from the field settings, labels
// resolved from the merged option map, soft-deleted options withheld.
// Optional fields get a leading "—" item that commits null.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string | null]
}>()

interface OptionItem {
  label: string
  value: string | null
}

const items = computed<OptionItem[]>(() => {
  const options = props.field.options ?? {}
  const base = Object.entries(options)
    .filter(([, opt]) => !opt.deleted)
    .map(([key, opt]) => ({ label: opt.label, value: key as string | null }))
  return props.field.required ? base : [{ label: '—', value: null }, ...base]
})

const current = computed(() =>
  typeof props.modelValue === 'string' && props.modelValue !== '' ? props.modelValue : null
)

function onChange(value: unknown) {
  const next = typeof value === 'string' && value !== '' ? value : null
  if (next === current.value) return
  emit('commit', next)
}
</script>

<template>
  <USelectMenu
    :model-value="current"
    :items="items"
    value-key="value"
    label-key="label"
    placeholder="Select..."
    class="w-full sm:max-w-xs"
    @update:model-value="onChange"
  />
</template>
