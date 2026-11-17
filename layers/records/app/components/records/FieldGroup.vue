<script setup lang="ts">
// One section of a record's fields sidebar: a row for each field with a value
// and, for those who can edit, an add button for each empty one.
import { getRecordsFieldWidget } from '#records'
import type { RecordsFieldSetting } from '../../utils/field-kinds'

const props = withDefaults(defineProps<{
  label?: string
  fields: RecordsFieldSetting[]
  /** Values keyed by field key. */
  values: Record<string, unknown>
  /** The caller can change these fields. */
  editable: boolean
  /** False for a field that can't be filled in yet: it gets no add button. */
  addable?: (field: RecordsFieldSetting) => boolean
}>(), {
  label: undefined,
  addable: undefined
})

const emit = defineEmits<{
  /** A yes/no field's add button was pressed. */
  commit: [field: RecordsFieldSetting, value: unknown]
}>()

defineSlots<{
  /** One field's row. */
  default: (props: { field: RecordsFieldSetting }) => unknown
}>()

const isEmpty = (field: RecordsFieldSetting) => recordsFieldIsEmpty(props.values[field.key])

function canAdd(field: RecordsFieldSetting): boolean {
  if (!props.editable) return false
  if (!recordsRendererFor(field.kind).component && !getRecordsFieldWidget(field.kind)) return false
  return props.addable?.(field) ?? true
}

// Fields that have held a value since mount: they keep their row when cleared.
const kept = ref(new Set<string>())
watch(() => props.fields.filter(f => !isEmpty(f)).map(f => f.key), (keys) => {
  for (const key of keys) kept.value.add(key)
}, { immediate: true })

// The field opened from its add button and not filled in yet.
const pending = ref<string | null>(null)

const rows = computed(() => props.fields.filter((f) => {
  if (!isEmpty(f)) return true
  if (!props.editable) return false
  return f.required || ((kept.value.has(f.key) || pending.value === f.key) && canAdd(f))
}))
const buttons = computed(() => {
  const shown = new Set(rows.value.map(f => f.key))
  return props.fields.filter(f => !shown.has(f.key) && canAdd(f))
})

const root = ref<HTMLElement | null>(null)
const rowEl = (key: string) =>
  root.value?.querySelector<HTMLElement>(`[data-field-row="${CSS.escape(key)}"]`) ?? null

// Puts the cursor in the row's input, or opens its picker when it has none.
function openEditor(row: HTMLElement) {
  const input = row.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([type="file"]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]')
  if (!input) {
    row.querySelector<HTMLElement>('button:not([disabled])')?.click()
    return
  }
  input.focus()
  if (input instanceof HTMLInputElement && (input.type === 'date' || input.type === 'datetime-local')) {
    try {
      input.showPicker()
    } catch {
      // The picker needs a recent click; the focused input is enough without it.
    }
  }
}

async function add(field: RecordsFieldSetting) {
  if (field.kind === 'boolean') {
    emit('commit', field, true)
    return
  }
  pending.value = field.key
  await nextTick()
  const row = rowEl(field.key)
  if (row) openEditor(row)
}

// Menus and pickers render outside the row, in a popper layer.
const OVERLAY = '[data-reka-popper-content-wrapper]'

function onOutside(event: Event) {
  const key = pending.value
  const target = event.target
  if (!key || !(target instanceof Element)) return
  const row = rowEl(key)
  if (row?.contains(target) || target.closest(OVERLAY)) return
  // A dialog's focus trap focuses a container around the row; that isn't leaving it.
  if (event.type === 'focusin' && row && target.contains(row)) return
  // Wait for the editor's blur to commit its draft before the row can go.
  setTimeout(() => {
    if (pending.value === key) pending.value = null
  }, 0)
}

watch(pending, (key, _old, onCleanup) => {
  if (!key) return
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('focusin', onOutside, true)
  onCleanup(() => {
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('focusin', onOutside, true)
  })
})
</script>

<template>
  <section
    v-if="rows.length > 0 || buttons.length > 0"
    ref="root"
    class="space-y-2"
  >
    <h2
      v-if="label"
      class="text-xs font-semibold uppercase tracking-wide text-(--ui-text-muted) px-1"
    >
      {{ label }}
    </h2>
    <div
      v-if="rows.length > 0"
      class="border border-(--ui-border) rounded-lg divide-y divide-(--ui-border) bg-(--ui-bg)"
    >
      <div
        v-for="field in rows"
        :key="field.key"
        :data-field-row="field.key"
      >
        <slot :field="field" />
      </div>
    </div>
    <div
      v-if="buttons.length > 0"
      class="flex flex-wrap gap-1.5"
    >
      <UButton
        v-for="field in buttons"
        :key="field.key"
        color="neutral"
        variant="outline"
        size="xs"
        icon="i-lucide-plus"
        :aria-label="`Add ${field.label}`"
        @click="add(field)"
      >
        <UIcon
          :name="recordsFieldIcon(field)"
          class="size-3.5 shrink-0"
        />
        {{ field.label }}
      </UButton>
    </div>
  </section>
</template>
