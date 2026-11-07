<script setup lang="ts">
// Options vocabulary editor for select-ish kinds (key_select, multi_select,
// tags). Edits the merged option set as full desired state — the server
// persists only what differs from the code manifest (rename/recolor become
// per-option overrides; brand-new keys become admin-added custom options).
// Removal is soft: `deleted` keeps historical values renderable while the
// option stops being offered. On a status field, options can be marked as
// meaning the record is closed, and at least one open and one closed option
// always remain. Rows reorder by dragging the grip or with the arrow keys on it.
import type { RecordsFieldOption } from '#records'
import type { RecordsBadgeColor } from '../../../utils/field-kinds'

const options = defineModel<Record<string, RecordsFieldOption>>({ required: true })

const props = defineProps<{
  disabled?: boolean
  /** Status field: options can be marked as meaning the record is closed. */
  closable?: boolean
}>()

const COLOR_ITEMS: Array<{ label: string, value: string }> = [
  { label: 'None', value: 'none' },
  { label: 'Primary', value: 'primary' },
  { label: 'Secondary', value: 'secondary' },
  { label: 'Success', value: 'success' },
  { label: 'Info', value: 'info' },
  { label: 'Warning', value: 'warning' },
  { label: 'Error', value: 'error' },
  { label: 'Neutral', value: 'neutral' }
]

const entries = computed(() => Object.entries(options.value))

// A status keeps at least one open and one closed option, so records can
// always be closed and reopened.
const liveOpen = computed(() => entries.value.filter(([, o]) => !o.deleted && !o.closed).length)
const liveClosed = computed(() => entries.value.filter(([, o]) => !o.deleted && o.closed).length)

function isLastOfItsSide(option: RecordsFieldOption): boolean {
  if (!props.closable || option.deleted) return false
  return option.closed ? liveClosed.value <= 1 : liveOpen.value <= 1
}

function patchOption(key: string, patch: Partial<RecordsFieldOption>) {
  const current = options.value[key]
  if (!current) return
  options.value = { ...options.value, [key]: { ...current, ...patch } }
}

const list = ref<HTMLElement | null>(null)
const reorderable = computed(() => !props.disabled && entries.value.length > 1)
const dragKey = ref<string | null>(null)
const dragOverKey = ref<string | null>(null)

function moveOption(from: number, to: number) {
  const next = [...entries.value]
  if (from === to || to < 0 || to >= next.length) return
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  options.value = Object.fromEntries(next)
}

async function moveByKey(key: string, delta: number) {
  if (!reorderable.value) return
  const from = entries.value.findIndex(([k]) => k === key)
  moveOption(from, from + delta)
  await nextTick()
  list.value?.querySelector<HTMLElement>(`[data-option-handle="${key}"]`)?.focus()
}

function onDragStart(key: string, event: DragEvent) {
  dragKey.value = key
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', key)
  const row = (event.target as HTMLElement).closest('li')
  if (row) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2)
}

function onDragEnd() {
  dragKey.value = null
  dragOverKey.value = null
}

function onDrop(overKey: string) {
  const from = entries.value.findIndex(([k]) => k === dragKey.value)
  const to = entries.value.findIndex(([k]) => k === overKey)
  onDragEnd()
  if (from >= 0 && to >= 0) moveOption(from, to)
}

function setColor(key: string, value: string) {
  const current = options.value[key]
  if (!current) return
  const next: RecordsFieldOption = { ...current }
  if (value === 'none') delete next.color
  else next.color = value
  options.value = { ...options.value, [key]: next }
}

// Option keys may start with a digit (unlike type/field slugs), so this is
// looser than recordsSlugify: '18–25' → '18_25'.
function optionKeySlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .slice(0, 41)
}

const newLabel = ref('')
const newKey = computed(() => optionKeySlug(newLabel.value))
const canAdd = computed(() =>
  newLabel.value.trim().length > 0
  && newKey.value.length > 0
  && !(newKey.value in options.value)
)

function addOption() {
  if (!canAdd.value || props.disabled) return
  options.value = { ...options.value, [newKey.value]: { label: newLabel.value.trim() } }
  newLabel.value = ''
}

function badgeColor(option: RecordsFieldOption): RecordsBadgeColor {
  const allowed = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']
  return option.color && allowed.includes(option.color) ? option.color as RecordsBadgeColor : 'neutral'
}
</script>

<template>
  <div class="space-y-2">
    <ul
      ref="list"
      class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
    >
      <li
        v-for="[key, option] in entries"
        :key="key"
        class="flex items-center gap-2 px-2 py-1.5 transition-colors"
        :class="{
          'opacity-50': option.deleted,
          'bg-(--ui-bg-elevated)': dragKey !== null && dragOverKey === key && dragKey !== key
        }"
        @dragover.prevent="dragKey !== null && (dragOverKey = key)"
        @drop.prevent="onDrop(key)"
      >
        <span
          role="button"
          :tabindex="reorderable ? 0 : -1"
          class="shrink-0 -mx-1 p-0.5 rounded text-(--ui-text-dimmed) focus-visible:outline-2 focus-visible:outline-(--ui-primary)"
          :class="reorderable ? 'cursor-grab' : 'opacity-50'"
          :data-option-handle="key"
          :draggable="reorderable"
          :aria-disabled="!reorderable"
          :aria-label="`Reorder ${option.label}`"
          @dragstart="onDragStart(key, $event)"
          @dragend="onDragEnd"
          @keydown.up.prevent="moveByKey(key, -1)"
          @keydown.down.prevent="moveByKey(key, 1)"
        >
          <UIcon
            name="i-lucide-grip-vertical"
            class="size-4 block"
          />
        </span>
        <UBadge
          :color="badgeColor(option)"
          variant="subtle"
          size="sm"
          class="shrink-0 font-mono"
        >
          {{ key }}
        </UBadge>
        <UInput
          :model-value="option.label"
          size="sm"
          class="flex-1 min-w-24"
          :disabled="disabled || option.deleted"
          @update:model-value="patchOption(key, { label: String($event) })"
        />
        <USelectMenu
          :model-value="option.color ?? 'none'"
          :items="COLOR_ITEMS"
          value-key="value"
          label-key="label"
          :search-input="false"
          size="sm"
          class="w-28 shrink-0"
          :disabled="disabled || option.deleted"
          @update:model-value="setColor(key, String($event))"
        />
        <UButton
          v-if="closable"
          icon="i-lucide-archive"
          :variant="option.closed ? 'soft' : 'ghost'"
          :color="option.closed ? 'primary' : 'neutral'"
          size="xs"
          :aria-label="`${option.label} counts as closed`"
          :aria-pressed="!!option.closed"
          :title="isLastOfItsSide(option)
            ? `A status needs at least one ${option.closed ? 'closed' : 'open'} option`
            : option.closed ? 'Counts as closed' : 'Mark as closed'"
          :disabled="disabled || option.deleted || isLastOfItsSide(option)"
          @click="patchOption(key, { closed: !option.closed })"
        />
        <UButton
          :icon="option.deleted ? 'i-lucide-rotate-ccw' : 'i-lucide-trash-2'"
          variant="ghost"
          color="neutral"
          size="xs"
          :aria-label="option.deleted ? `Restore ${option.label}` : `Remove ${option.label}`"
          :title="option.deleted
            ? 'Restore option'
            : isLastOfItsSide(option)
              ? `A status needs at least one ${option.closed ? 'closed' : 'open'} option`
              : 'Remove option (kept for historical values)'"
          :disabled="disabled || isLastOfItsSide(option)"
          @click="patchOption(key, { deleted: !option.deleted })"
        />
      </li>
      <li
        v-if="entries.length === 0"
        class="px-3 py-4 text-sm text-(--ui-text-muted) text-center"
      >
        No options yet.
      </li>
    </ul>

    <form
      class="flex items-center gap-2"
      @submit.prevent="addOption"
    >
      <UInput
        v-model="newLabel"
        placeholder="New option label"
        size="sm"
        class="flex-1"
        :disabled="disabled"
      />
      <span
        v-if="newKey"
        class="text-xs text-(--ui-text-muted) font-mono shrink-0"
      >{{ newKey }}</span>
      <UButton
        type="submit"
        icon="i-lucide-plus"
        size="sm"
        variant="soft"
        :disabled="disabled || !canAdd"
      >
        Add
      </UButton>
    </form>
  </div>
</template>
