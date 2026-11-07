<script setup lang="ts">
// Inline date editor: a native date input committing the ISO date string
// (YYYY-MM-DD). Clearing the input commits null.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string | null]
}>()

// The stored value may be a bare date or a full timestamp; the input needs
// YYYY-MM-DD. Bare dates pass through untouched so they round-trip without
// a timezone shift.
const current = computed(() => {
  if (typeof props.modelValue !== 'string' || props.modelValue === '') return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(props.modelValue)) return props.modelValue
  const d = new Date(props.modelValue)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
})
const draft = ref(current.value)
watch(current, (v) => {
  draft.value = v
})

function commit() {
  if (draft.value === current.value) return
  emit('commit', draft.value === '' ? null : draft.value)
}
</script>

<template>
  <UInput
    v-model="draft"
    type="date"
    class="w-full sm:max-w-xs"
    @blur="commit"
    @change="commit"
  />
</template>
