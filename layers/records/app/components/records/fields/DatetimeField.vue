<script setup lang="ts">
// Inline date+time editor in the viewer's timezone, committing a full ISO
// timestamp. A date picked with no time gets 08:00; clearing the date commits null.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string | null]
}>()

const DEFAULT_TIME = '08:00'

// The date and time inputs need YYYY-MM-DD and HH:mm in local time.
function toLocalParts(iso: string): { date: string, time: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

const current = computed(() =>
  typeof props.modelValue === 'string' && props.modelValue !== '' ? toLocalParts(props.modelValue) : { date: '', time: '' }
)
const date = ref(current.value.date)
const time = ref(current.value.time)
watch(current, (v) => {
  date.value = v.date
  time.value = v.time
})

function commit() {
  if (date.value === '') {
    time.value = ''
    if (current.value.date !== '') emit('commit', null)
    return
  }
  if (time.value === '') time.value = DEFAULT_TIME
  if (date.value === current.value.date && time.value === current.value.time) return
  emit('commit', new Date(`${date.value}T${time.value}`).toISOString())
}
</script>

<template>
  <div class="flex items-center gap-2 w-full sm:max-w-xs">
    <UInput
      v-model="date"
      type="date"
      class="flex-1"
      @blur="commit"
      @change="commit"
    />
    <UInput
      v-model="time"
      type="time"
      class="w-28"
      :disabled="date === ''"
      @blur="commit"
      @change="commit"
    />
  </div>
</template>
