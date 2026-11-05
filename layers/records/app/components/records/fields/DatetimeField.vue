<script setup lang="ts">
// Inline date+time editor: a native datetime-local input in the viewer's
// timezone committing a full ISO timestamp. Clearing the input commits null.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string | null]
}>()

// datetime-local needs YYYY-MM-DDTHH:mm in local time.
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const current = computed(() =>
  typeof props.modelValue === 'string' && props.modelValue !== '' ? toLocalInput(props.modelValue) : ''
)
const draft = ref(current.value)
watch(current, (v) => {
  draft.value = v
})

function commit() {
  if (draft.value === current.value) return
  emit('commit', draft.value === '' ? null : new Date(draft.value).toISOString())
}
</script>

<template>
  <UInput
    v-model="draft"
    type="datetime-local"
    class="w-full sm:max-w-xs"
    @blur="commit"
    @change="commit"
  />
</template>
