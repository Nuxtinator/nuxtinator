<script setup lang="ts">
// A card row that sets its field from the board: clicking it opens the
// field's own editor in a popover, ready to type or pick. A single value
// closes it once chosen; lists stay open to add more. The editor shows each
// committed value until the feed brings the saved one.
import type { RecordsFieldSetting } from '#records/client'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  field: RecordsFieldSetting
  value: unknown
  /** Tags fields: where the editor gets its suggestions. */
  suggestUrl?: string
}>()

const emit = defineEmits<{
  /** `previous` is the value the editor showed before this change. */
  commit: [value: unknown, previous: unknown]
}>()

const open = ref(false)

const draft = ref<{ value: unknown } | null>(null)
watch(() => props.value, () => {
  draft.value = null
})
const current = computed(() => draft.value ? draft.value.value : props.value)

const holdsList = computed(() =>
  props.field.kind === 'multi_select' || props.field.kind === 'tags' || props.field.kind === 'connection'
  || (props.field.kind === 'user_select' && !!props.field.multiple))

function onCommit(value: unknown) {
  const previous = current.value
  draft.value = { value }
  emit('commit', value, previous)
  if (!holdsList.value) open.value = false
}

function toggle() {
  open.value = !open.value
}

// Puts the cursor in the editor's input, or opens its picker when it has none.
const body = ref<HTMLElement | null>(null)
watch(body, async (el) => {
  if (!el) return
  await nextTick()
  const input = el.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([type="file"]):not([disabled]), textarea:not([disabled])')
  if (!input) {
    el.querySelector<HTMLElement>('button:not([disabled])')?.click()
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
})
</script>

<template>
  <UPopover
    v-model:open="open"
    :content="{ align: 'start' }"
  >
    <div
      v-bind="$attrs"
      role="button"
      tabindex="0"
      :aria-label="`Set ${field.label}`"
      @click.stop
      @keydown.enter.prevent.stop="toggle"
      @keydown.space.prevent.stop="toggle"
    >
      <slot />
    </div>
    <template #content>
      <div
        ref="body"
        class="w-72 p-1"
      >
        <RecordsFieldRow
          layout="stacked"
          class="p-2"
          :field="field"
          :value="current"
          editable
          :suggest-url="suggestUrl"
          @commit="onCommit"
        />
      </div>
    </template>
  </UPopover>
</template>
