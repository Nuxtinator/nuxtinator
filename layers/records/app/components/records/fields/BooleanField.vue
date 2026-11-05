<script setup lang="ts">
// Inline boolean editor: a switch that commits on every toggle. An unset
// value renders as off; committing writes an explicit true/false.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: boolean]
}>()

const current = computed(() => props.modelValue === true)

function onChange(value: boolean) {
  if (value === current.value) return
  emit('commit', value)
}
</script>

<template>
  <USwitch
    :model-value="current"
    @update:model-value="onChange"
  />
</template>
