<script setup lang="ts">
// Inline number editor: commits on blur or Enter. Clearing the input
// commits null.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: number | null]
}>()

const current = computed(() => typeof props.modelValue === 'number' ? props.modelValue : null)
const draft = ref<number | null>(current.value)
watch(current, (v) => {
  draft.value = v
})

function commit() {
  if (draft.value === current.value) return
  emit('commit', draft.value)
}

function blurTarget(event: Event) {
  const el = event.target as HTMLElement
  el.blur()
}
</script>

<template>
  <UInputNumber
    v-model="draft"
    class="w-full sm:max-w-xs"
    @blur="commit"
    @keydown.enter.prevent="blurTarget"
  />
</template>
