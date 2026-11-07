<script setup lang="ts">
// Inline text editor: holds a local draft and commits on blur or Enter.
// An empty draft commits null (clears the value).
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

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

function blurTarget(event: Event) {
  (event.target as HTMLElement).blur()
}
</script>

<template>
  <UInput
    v-model="draft"
    class="w-full"
    @blur="commit"
    @keydown.enter.prevent="blurTarget"
  />
</template>
