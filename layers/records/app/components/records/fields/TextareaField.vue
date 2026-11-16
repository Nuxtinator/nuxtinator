<script setup lang="ts">
// Inline multi-line editor: commits on blur only (Enter inserts a newline).
// An empty draft commits null (clears the value).
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = withDefaults(defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
  /** The editor's height before it grows with its text. */
  rows?: number
}>(), {
  rows: 3
})

const emit = defineEmits<{
  commit: [value: string | null]
}>()

const current = computed(() => typeof props.modelValue === 'string' ? props.modelValue : '')
const draft = ref(current.value)
watch(current, (v) => {
  draft.value = v
})

function commit() {
  const next = draft.value.trim()
  if (next === current.value) return
  emit('commit', next === '' ? null : next)
}
</script>

<template>
  <UTextarea
    v-model="draft"
    class="w-full"
    :rows="rows"
    autoresize
    @blur="commit"
  />
</template>
